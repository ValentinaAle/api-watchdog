import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManualRunRedisConnection } from "../../packages/queue/src/index.ts";
import {
  ADMISSION_VALIDITY_LUA,
  MANUAL_RUN_ACQUIRE_LUA,
  createAdmissionExecutor,
  createManualRunCoordinator,
  type RedisScriptClient,
} from "../../apps/web/lib/monitors/run-coordinator.ts";

const redisUrl = process.env.MANUAL_RUN_REDIS_TEST_URL;
const integration = redisUrl ? describe : describe.skip;
let redis: ReturnType<typeof createManualRunRedisConnection>;

integration("manual-run coordinator Redis Lua", () => {
  beforeEach(async () => {
    redis = createManualRunRedisConnection(redisUrl!);
    await redis.connect();
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.disconnect();
  });

  function coordinator(tokens: string[]) {
    return createManualRunCoordinator({
      getClient: async () => redis as unknown as RedisScriptClient,
      ownerToken: () => tokens.shift() ?? "next-owner",
    });
  }

  it("atomically admits only three project leases and does not let a stale owner release a successor", async () => {
    const run = coordinator(["a", "b", "c", "d", "successor"]);
    const results = await Promise.all(["one", "two", "three", "four"].map((monitorId) => run.acquire({ projectId: "project", monitorId })));
    expect(results.filter((result) => result.kind === "admitted")).toHaveLength(3);
    expect(results.filter((result) => result.kind === "project_capacity")).toHaveLength(1);

    const first = await coordinator(["old"]).acquire({ projectId: "other", monitorId: "monitor" });
    if (first.kind !== "admitted") throw new Error("expected first lease");
    await redis.del("api-watchdog:manual-run:lease:other:monitor", "api-watchdog:manual-run:cooldown:other:monitor");
    const successor = await coordinator(["new"]).acquire({ projectId: "other", monitorId: "monitor" });
    if (successor.kind !== "admitted") throw new Error("expected successor");
    await coordinator([]).release({ projectId: "other", monitorId: "monitor", ownerToken: first.ownerToken });
    await expect(coordinator(["blocked"]).acquire({ projectId: "other", monitorId: "monitor" })).resolves.toEqual({ kind: "in_progress" });
  });

  it("prunes an expired project ZSET member before capacity and rejects a server-expired command without mutations", async () => {
    const run = coordinator(["old", "fresh"]);
    const old = await run.acquire({ projectId: "project", monitorId: "old" });
    if (old.kind !== "admitted") throw new Error("expected first lease");
    const projectKey = "api-watchdog:manual-run:project:project:leases";
    await redis.del("api-watchdog:manual-run:lease:project:old", "api-watchdog:manual-run:cooldown:project:old");
    await redis.zadd(projectKey, 0, old.ownerToken);
    await expect(run.acquire({ projectId: "project", monitorId: "fresh" })).resolves.toMatchObject({ kind: "admitted" });
    expect(await redis.zscore(projectKey, old.ownerToken)).toBeNull();

    const execute = createAdmissionExecutor({ getClient: async () => redis as unknown as RedisScriptClient });
    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], [])).resolves.toEqual({ kind: "accepted" });
    const result = await redis.eval(MANUAL_RUN_ACQUIRE_LUA, 3, "lease", "cooldown", "project", "owner", "15000", "30000", "3", "0");
    expect(result).toEqual(["ADMISSION_EXPIRED"]);
    expect(await redis.exists("lease", "cooldown")).toBe(0);
  });
});

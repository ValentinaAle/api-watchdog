import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("atomically admits only one same-monitor owner across Promise.all", async () => {
    const run = coordinator(["a", "b", "c", "d"]);
    const results = await Promise.all(Array.from({ length: 4 }, () => run.acquire({ projectId: "project", monitorId: "same" })));
    expect(results.filter((result) => result.kind === "admitted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "in_progress")).toHaveLength(3);
  });

  it("keeps cooldown after a real lease expires, then allows a post-cooldown admission without sleeping", async () => {
    const run = coordinator(["first", "blocked", "after"]);
    const first = await run.acquire({ projectId: "project", monitorId: "monitor" });
    if (first.kind !== "admitted") throw new Error("expected admission");
    const lease = "api-watchdog:manual-run:lease:project:monitor";
    const cooldown = "api-watchdog:manual-run:cooldown:project:monitor";
    expect(await redis.pttl(cooldown)).toBeGreaterThan(29_000);
    await redis.pexpireat(lease, 0);
    await expect(run.acquire({ projectId: "project", monitorId: "monitor" })).resolves.toEqual({ kind: "cooldown" });
    await redis.pexpireat(cooldown, 0);
    await expect(run.acquire({ projectId: "project", monitorId: "monitor" })).resolves.toMatchObject({ kind: "admitted" });
  });

  it("isolates equal monitor identifiers between projects and makes repeated/wrong release harmless", async () => {
    const run = coordinator(["alpha", "beta"]);
    const alpha = await run.acquire({ projectId: "alpha", monitorId: "same" });
    const beta = await run.acquire({ projectId: "beta", monitorId: "same" });
    if (alpha.kind !== "admitted" || beta.kind !== "admitted") throw new Error("expected isolated admissions");
    await expect(run.release({ projectId: "alpha", monitorId: "same", ownerToken: "wrong" })).resolves.toEqual({ kind: "released" });
    await expect(run.acquire({ projectId: "alpha", monitorId: "same" })).resolves.toEqual({ kind: "in_progress" });
    await expect(run.release({ projectId: "alpha", monitorId: "same", ownerToken: alpha.ownerToken })).resolves.toEqual({ kind: "released" });
    await expect(run.release({ projectId: "alpha", monitorId: "same", ownerToken: alpha.ownerToken })).resolves.toEqual({ kind: "released" });
    await expect(run.acquire({ projectId: "beta", monitorId: "same" })).resolves.toEqual({ kind: "in_progress" });
  });

  it("uses an injected Redis-compatible clock for exact 29,999/30,000 ms cooldown boundaries", async () => {
    let now = 0;
    let cooldownUntil = 0;
    const simulated: RedisScriptClient = {
      time: async () => [String(Math.floor(now / 1_000)), String((now % 1_000) * 1_000)],
      eval: async (script) => {
        if (!script.includes("MANUAL_RUN_ACQUIRE")) return ["ADMITTED"];
        if (cooldownUntil > now) return ["RUN_COOLDOWN"];
        cooldownUntil = now + 30_000;
        return ["ADMITTED"];
      },
    };
    const run = createManualRunCoordinator({ getClient: async () => simulated, monotonicNow: () => now, ownerToken: () => "owner" });
    await expect(run.acquire({ projectId: "project", monitorId: "monitor" })).resolves.toMatchObject({ kind: "admitted" });
    now = 29_999;
    await expect(run.acquire({ projectId: "project", monitorId: "monitor" })).resolves.toEqual({ kind: "cooldown" });
    now = 30_000;
    await expect(run.acquire({ projectId: "project", monitorId: "monitor" })).resolves.toMatchObject({ kind: "admitted" });
  });

  it("fails closed for an injected lost admission response and cannot authorize an HTTP caller", async () => {
    vi.useFakeTimers();
    let now = 0;
    const client: RedisScriptClient = { time: async () => ["0", "0"], eval: async () => new Promise<unknown>(() => undefined) };
    const run = createManualRunCoordinator({ getClient: async () => client, monotonicNow: () => now, operationTimeoutMs: 5 });
    try {
      const pending = run.acquire({ projectId: "project", monitorId: "monitor" });
      await vi.advanceTimersByTimeAsync(0);
      now = 5;
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toEqual({ kind: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a real successor lease when an injected lost release response arrives late", async () => {
    const first = await coordinator(["old"]).acquire({ projectId: "project", monitorId: "monitor" });
    if (first.kind !== "admitted") throw new Error("expected old lease");
    await redis.del("api-watchdog:manual-run:lease:project:monitor", "api-watchdog:manual-run:cooldown:project:monitor");
    const successor = await coordinator(["new"]).acquire({ projectId: "project", monitorId: "monitor" });
    if (successor.kind !== "admitted") throw new Error("expected successor");
    vi.useFakeTimers();
    let now = 0;
    const lossy: RedisScriptClient = {
      time: async () => redis.time(),
      eval: async (script, count, ...args) => {
        await redis.eval(script, count, ...args);
        return new Promise<unknown>(() => undefined);
      },
    };
    const run = createManualRunCoordinator({ getClient: async () => lossy, monotonicNow: () => now, operationTimeoutMs: 5 });
    try {
      const pending = run.release({ projectId: "project", monitorId: "monitor", ownerToken: first.ownerToken });
      await vi.advanceTimersByTimeAsync(0);
      now = 5;
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toEqual({ kind: "unavailable" });
      await expect(coordinator(["blocked"]).acquire({ projectId: "project", monitorId: "monitor" })).resolves.toEqual({ kind: "in_progress" });
    } finally {
      vi.useRealTimers();
    }
  });

});

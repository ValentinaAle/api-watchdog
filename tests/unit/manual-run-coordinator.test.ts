import { describe, expect, it, vi } from "vitest";
import { MANUAL_RUN_REDIS_OPTIONS } from "../../packages/queue/src/index.ts";
import {
  ADMISSION_VALIDITY_LUA,
  COORDINATION_OPERATION_TIMEOUT_MS,
  createAdmissionExecutor,
  createProductionAdmissionExecutor,
  type RedisScriptClient,
} from "../../apps/web/lib/monitors/run-coordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("manual-run Redis admission safety", () => {
  it("uses a dedicated no-queue, no-retry Redis profile", () => {
    expect(MANUAL_RUN_REDIS_OPTIONS).toMatchObject({
      autoResendUnfulfilledCommands: false,
      commandTimeout: COORDINATION_OPERATION_TIMEOUT_MS,
      connectTimeout: COORDINATION_OPERATION_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      socketTimeout: COORDINATION_OPERATION_TIMEOUT_MS,
    });
    expect(MANUAL_RUN_REDIS_OPTIONS.retryStrategy?.(1)).toBeNull();
  });

  it("requires Redis TIME validation before an admission script can mutate state", () => {
    expect(ADMISSION_VALIDITY_LUA).toContain('redis.call("TIME")');
    expect(ADMISSION_VALIDITY_LUA).toContain('return { "ADMISSION_EXPIRED" }');
  });

  it("fails closed when a disconnected client cannot be created", async () => {
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://unavailable.example:6379",
      createClient: () => { throw new Error("sensitive connection detail"); },
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
  });

  it("does not accept a lost response even when Redis may execute later", async () => {
    const response = deferred<unknown>();
    const calls: string[] = [];
    const client: RedisScriptClient = {
      eval: async (script) => {
        calls.push(script);
        return response.promise;
      },
    };
    const execute = createAdmissionExecutor({
      getClient: async () => client,
      operationTimeoutMs: 1,
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], [])).resolves.toEqual({ kind: "unavailable" });
    response.resolve(["ADMITTED"]);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("uses one absolute coordination deadline across client creation and eval", async () => {
    vi.useFakeTimers();
    let now = 0;
    const response = deferred<unknown>();
    const client: RedisScriptClient = { eval: async () => response.promise };
    const execute = createAdmissionExecutor({
      getClient: async () => {
        now = 1_900;
        return client;
      },
      now: () => now,
      operationTimeoutMs: 2_000,
    });
    const pending = execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []);
    let settled = false;
    void pending.finally(() => { settled = true; });

    try {
      await vi.advanceTimersByTimeAsync(101);
      expect(settled).toBe(true);
    } finally {
      response.resolve(["ADMITTED"]);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      vi.useRealTimers();
    }
  });

  it("returns expired when the server-side script rejects a queued late admission", async () => {
    let deadline = 0;
    const client: RedisScriptClient = {
      eval: async (_script, _keys, ...args) => {
        deadline = Number(args.at(-1));
        return ["ADMISSION_EXPIRED"];
      },
    };
    const execute = createAdmissionExecutor({ getClient: async () => client, now: () => 10_000 });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, ["lease"], ["owner"]))
      .resolves.toEqual({ kind: "expired" });
    expect(deadline).toBe(10_000 + COORDINATION_OPERATION_TIMEOUT_MS);
  });

  it("rejects malformed or unguarded script outcomes", async () => {
    const client: RedisScriptClient = { eval: async (script) => script.includes("UNKNOWN") ? ["UNKNOWN"] : ["ADMITTED"] };
    const execute = createAdmissionExecutor({ getClient: async () => client });

    await expect(execute("return { \"ADMITTED\" }", [], [])).resolves.toEqual({ kind: "unavailable" });
    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "UNKNOWN" }`, [], [])).resolves.toEqual({ kind: "unavailable" });
  });
});

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

function redisTime(milliseconds: number): readonly [string, string] {
  return [String(Math.floor(milliseconds / 1_000)), String((milliseconds % 1_000) * 1_000)];
}

/**
 * Independent Redis-script contract harness. It models Redis TIME and records
 * whether the mutation following PR1A's guard would run; it is deliberately
 * not an assertion over Lua source text.
 */
function semanticAdmissionClient(serverClock: { now: number; mutations: number }): RedisScriptClient {
  return {
    time: async () => redisTime(serverClock.now),
    eval: async (_script, _keys, ...args) => {
      const deadline = Number(args.at(-1));
      if (serverClock.now >= deadline) return ["ADMISSION_EXPIRED"];
      serverClock.mutations += 1;
      return ["ADMITTED"];
    },
  };
}

describe("manual-run Redis admission safety", () => {
  it("uses a dedicated no-queue, no-retry Redis profile", () => {
    expect(MANUAL_RUN_REDIS_OPTIONS).toMatchObject({
      autoResendUnfulfilledCommands: false,
      commandTimeout: COORDINATION_OPERATION_TIMEOUT_MS,
      connectTimeout: COORDINATION_OPERATION_TIMEOUT_MS,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      socketTimeout: COORDINATION_OPERATION_TIMEOUT_MS,
    });
    expect(MANUAL_RUN_REDIS_OPTIONS.retryStrategy?.(1)).toBeNull();
  });

  it("uses Redis TIME to derive an expiry independent of Node wall-clock", async () => {
    let serverDeadline = 0;
    const client: RedisScriptClient = {
      time: async () => redisTime(50_000),
      eval: async (_script, _keys, ...args) => {
        serverDeadline = Number(args.at(-1));
        return ["ADMITTED"];
      },
    };
    const execute = createAdmissionExecutor({
      getClient: async () => client,
      monotonicNow: () => 0,
      operationTimeoutMs: 2_000,
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "accepted" });
    expect(serverDeadline).toBe(52_000);
  });

  it("fails closed when a disconnected client cannot be created", async () => {
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://unavailable.example:6379",
      createClient: () => { throw new Error("sensitive connection detail"); },
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
  });

  it("retries a new independent admission after persistent client creation failures", async () => {
    let creations = 0;
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://unavailable.example:6379",
      createClient: () => {
        creations += 1;
        throw new Error("connection failed");
      },
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
    expect(creations).toBe(2);
  });

  it("waits for readiness before TIME or EVAL", async () => {
    const ready = deferred<void>();
    let timeCalls = 0;
    let evalCalls = 0;
    const client: RedisScriptClient = {
      connect: async () => ready.promise,
      time: async () => { timeCalls += 1; return redisTime(1_000); },
      eval: async () => { evalCalls += 1; return ["ADMITTED"]; },
    };
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://coordination.example:6379",
      createClient: () => client,
    });

    const pending = execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []);
    await Promise.resolve();
    expect(timeCalls).toBe(0);
    expect(evalCalls).toBe(0);
    ready.resolve();
    await expect(pending).resolves.toEqual({ kind: "accepted" });
    expect(timeCalls).toBe(1);
    expect(evalCalls).toBe(1);
  });

  it("invalidates a late connection and lets only a new admission use a fresh client", async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const oldReady = deferred<void>();
    const oldDisconnect = vi.fn();
    let oldTimeCalls = 0;
    const oldClient: RedisScriptClient = {
      connect: async () => oldReady.promise,
      disconnect: oldDisconnect,
      time: async () => { oldTimeCalls += 1; return redisTime(1_000); },
      eval: async () => ["ADMITTED"],
    };
    const freshClient: RedisScriptClient = {
      connect: async () => undefined,
      time: async () => redisTime(2_000),
      eval: async () => ["ADMITTED"],
    };
    let creations = 0;
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://coordination.example:6379",
      createClient: () => (++creations === 1 ? oldClient : freshClient),
      monotonicNow: () => monotonic,
      operationTimeoutMs: 2_000,
    });

    try {
      const first = execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []);
      await vi.advanceTimersByTimeAsync(0);
      monotonic = 2_000;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toEqual({ kind: "unavailable" });
      expect(oldDisconnect).toHaveBeenCalledTimes(1);

      monotonic = 5_000;
      await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
        .resolves.toEqual({ kind: "accepted" });
      expect(creations).toBe(2);

      oldReady.resolve();
      await Promise.resolve();
      expect(oldTimeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when readiness resolves after its monotonic budget", async () => {
    let monotonic = 0;
    let timeCalls = 0;
    const client: RedisScriptClient = {
      connect: async () => { monotonic = 2_000; },
      time: async () => { timeCalls += 1; return redisTime(1_000); },
      eval: async () => ["ADMITTED"],
    };
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://coordination.example:6379",
      createClient: () => client,
      monotonicNow: () => monotonic,
      operationTimeoutMs: 2_000,
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
    expect(timeCalls).toBe(0);
  });

  it("discards a lost EVAL client and uses a fresh client only for the next admission", async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const oldReply = deferred<unknown>();
    const oldDisconnect = vi.fn(() => { throw new Error("close failed"); });
    const oldClient: RedisScriptClient = {
      time: async () => redisTime(10_000),
      eval: async () => oldReply.promise,
      disconnect: oldDisconnect,
    };
    const freshClient: RedisScriptClient = {
      time: async () => redisTime(20_000),
      eval: async () => ["ADMITTED"],
    };
    let creations = 0;
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://coordination.example:6379",
      createClient: () => (++creations === 1 ? oldClient : freshClient),
      monotonicNow: () => monotonic,
      operationTimeoutMs: 2_000,
    });

    try {
      const first = execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []);
      await vi.advanceTimersByTimeAsync(0);
      monotonic = 2_000;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toEqual({ kind: "unavailable" });
      expect(oldDisconnect).toHaveBeenCalledTimes(1);

      monotonic = 5_000;
      await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
        .resolves.toEqual({ kind: "accepted" });
      expect(creations).toBe(2);

      oldReply.resolve(["ADMITTED"]);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a lost TIME preflight before a new admission starts", async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const oldTime = deferred<readonly [string, string]>();
    const oldDisconnect = vi.fn();
    const oldClient: RedisScriptClient = {
      time: async () => oldTime.promise,
      eval: async () => ["ADMITTED"],
      disconnect: oldDisconnect,
    };
    const freshClient: RedisScriptClient = {
      time: async () => redisTime(30_000),
      eval: async () => ["ADMITTED"],
    };
    let creations = 0;
    const execute = createProductionAdmissionExecutor({
      redisUrl: "redis://coordination.example:6379",
      createClient: () => (++creations === 1 ? oldClient : freshClient),
      monotonicNow: () => monotonic,
      operationTimeoutMs: 2_000,
    });

    try {
      const first = execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []);
      await vi.advanceTimersByTimeAsync(0);
      monotonic = 2_000;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(first).resolves.toEqual({ kind: "unavailable" });
      expect(oldDisconnect).toHaveBeenCalledTimes(1);

      monotonic = 5_000;
      await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
        .resolves.toEqual({ kind: "accepted" });
      expect(creations).toBe(2);

      oldTime.resolve(redisTime(0));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a lost response even when Redis may execute later", async () => {
    vi.useFakeTimers();
    const response = deferred<unknown>();
    const calls: string[] = [];
    const client: RedisScriptClient = {
      time: async () => redisTime(0),
      eval: async (script) => {
        calls.push(script);
        return response.promise;
      },
    };
    const execute = createAdmissionExecutor({
      getClient: async () => client,
      monotonicNow: () => 0,
      operationTimeoutMs: 2_000,
    });

    try {
      const pending = execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ kind: "unavailable" });
      response.resolve(["ADMITTED"]);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one absolute monotonic deadline across client creation, TIME, and eval", async () => {
    vi.useFakeTimers();
    let now = 0;
    const response = deferred<unknown>();
    const client: RedisScriptClient = { time: async () => redisTime(1_000), eval: async () => response.promise };
    const execute = createAdmissionExecutor({
      getClient: async () => {
        now = 1_900;
        return client;
      },
      monotonicNow: () => now,
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

  it("does not authorize a late server-clock admission mutation", async () => {
    let monotonic = 0;
    const server = { now: 50_000, mutations: 0 };
    const client = semanticAdmissionClient(server);
    const execute = createAdmissionExecutor({
      getClient: async () => client,
      monotonicNow: () => monotonic,
      operationTimeoutMs: 2_000,
    });

    // The command is queued after the Redis TIME preflight but before EVAL.
    client.time = async () => {
      monotonic = 500;
      return redisTime(50_000);
    };
    client.eval = async (_script, _keys, ...args) => {
      server.now = 51_500;
      const deadline = Number(args.at(-1));
      if (server.now >= deadline) return ["ADMISSION_EXPIRED"];
      server.mutations += 1;
      return ["ADMITTED"];
    };

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "expired" });
    expect(server.mutations).toBe(0);
  });

  it("fails closed when the Redis TIME preflight response is lost", async () => {
    const response = deferred<readonly [string, string]>();
    let evalCalls = 0;
    const client: RedisScriptClient = {
      time: async () => response.promise,
      eval: async () => {
        evalCalls += 1;
        return ["ADMITTED"];
      },
    };
    const execute = createAdmissionExecutor({ getClient: async () => client, operationTimeoutMs: 1 });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
    response.resolve(redisTime(0));
    await Promise.resolve();
    expect(evalCalls).toBe(0);
  });

  it("does not send eval after a delayed Redis TIME preflight consumes the local window", async () => {
    let monotonic = 0;
    let evalCalls = 0;
    const client: RedisScriptClient = {
      time: async () => {
        monotonic = 2_000;
        return redisTime(100_000);
      },
      eval: async () => {
        evalCalls += 1;
        return ["ADMITTED"];
      },
    };
    const execute = createAdmissionExecutor({
      getClient: async () => client,
      monotonicNow: () => monotonic,
      operationTimeoutMs: 2_000,
    });

    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "ADMITTED" }`, [], []))
      .resolves.toEqual({ kind: "unavailable" });
    expect(evalCalls).toBe(0);
  });

  it("rejects malformed or unguarded script outcomes", async () => {
    const client: RedisScriptClient = {
      time: async () => redisTime(0),
      eval: async (script) => script.includes("UNKNOWN") ? ["UNKNOWN"] : ["ADMITTED"],
    };
    const execute = createAdmissionExecutor({ getClient: async () => client });

    await expect(execute("return { \"ADMITTED\" }", [], [])).resolves.toEqual({ kind: "unavailable" });
    await expect(execute(`${ADMISSION_VALIDITY_LUA}return { "UNKNOWN" }`, [], [])).resolves.toEqual({ kind: "unavailable" });
  });
});

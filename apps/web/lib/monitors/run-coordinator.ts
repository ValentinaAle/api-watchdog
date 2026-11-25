import "server-only";

import { randomUUID } from "node:crypto";

import { createManualRunRedisConnection } from "@api-watchdog/queue";

export const COORDINATION_OPERATION_TIMEOUT_MS = 2_000;
export const MANUAL_RUN_LEASE_TTL_MS = 15_000;
export const MANUAL_RUN_COOLDOWN_MS = 30_000;
export const MANUAL_RUN_PROJECT_CAPACITY = 3;

export type RedisScriptClient = {
  connect?: () => Promise<void>;
  disconnect?: () => void | Promise<void>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  time(): Promise<readonly (string | number)[]>;
};

export type AdmissionValidity = Readonly<{ serverDeadlineMs: number }>;

export type AdmissionAttempt =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "cooldown" }>
  | Readonly<{ kind: "project_capacity" }>
  | Readonly<{ kind: "unavailable" }>;

export type ManualRunAdmission =
  | Readonly<{ kind: "admitted"; ownerToken: string }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "cooldown" }>
  | Readonly<{ kind: "project_capacity" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "unavailable" }>;

export type ManualRunRelease = Readonly<{ kind: "released" }> | Readonly<{ kind: "unavailable" }>;

type AdmissionOptions = Readonly<{
  discardClient?: (client: RedisScriptClient) => void;
  discardPendingClient?: () => void;
  getClient: () => Promise<RedisScriptClient>;
  monotonicNow?: () => number;
  operationTimeoutMs?: number;
}>;

type ProductionAdmissionOptions = Readonly<{
  redisUrl?: string;
  createClient?: (redisUrl: string) => RedisScriptClient;
  monotonicNow?: () => number;
  operationTimeoutMs?: number;
}>;

type ProductionManualRunCoordinatorOptions = ProductionAdmissionOptions & Readonly<{
  ownerToken?: () => string;
}>;

type ManualRunCoordinatorOptions = AdmissionOptions & Readonly<{
  ownerToken?: () => string;
}>;

type ManualRunIdentity = Readonly<{ projectId: string; monitorId: string }>;
type ManualRunReleaseInput = ManualRunIdentity & Readonly<{ ownerToken: string }>;

function coordinationKeys({ projectId, monitorId }: ManualRunIdentity) {
  const scope = `${encodeURIComponent(projectId)}:${encodeURIComponent(monitorId)}`;
  return {
    cooldown: `api-watchdog:manual-run:cooldown:${scope}`,
    lease: `api-watchdog:manual-run:lease:${scope}`,
    projectLeases: `api-watchdog:manual-run:project:${encodeURIComponent(projectId)}:leases`,
  };
}

/**
 * PR1B appends its atomic lease/cooldown/capacity mutations after this guard.
 * Its deadline is measured in Redis' clock: Node wall-clock skew therefore
 * cannot extend the window of a delayed EVAL command.
 */
export const ADMISSION_VALIDITY_LUA = `
local serverDeadlineMs = tonumber(ARGV[#ARGV])
local redisTime = redis.call("TIME")
local redisNowMs = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
if redisNowMs >= serverDeadlineMs then
  return { "ADMISSION_EXPIRED" }
end
`;

/**
 * Redis runs this whole script atomically. It first applies the PR1A server
 * clock guard, then prunes only expired project owners before capacity checks.
 */
export const MANUAL_RUN_ACQUIRE_LUA = `${ADMISSION_VALIDITY_LUA}
-- MANUAL_RUN_ACQUIRE
local ownerToken = ARGV[1]
local leaseTtlMs = tonumber(ARGV[2])
local cooldownMs = tonumber(ARGV[3])
local projectCapacity = tonumber(ARGV[4])

redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", redisNowMs)
if redis.call("EXISTS", KEYS[1]) == 1 then return { "RUN_IN_PROGRESS" } end
if redis.call("EXISTS", KEYS[2]) == 1 then return { "RUN_COOLDOWN" } end
if redis.call("ZCARD", KEYS[3]) >= projectCapacity then return { "PROJECT_CAPACITY" } end

local created = redis.call("SET", KEYS[1], ownerToken, "NX", "PX", leaseTtlMs)
if not created then return { "RUN_IN_PROGRESS" } end
redis.call("SET", KEYS[2], "1", "PX", cooldownMs)
redis.call("ZADD", KEYS[3], redisNowMs + leaseTtlMs, ownerToken)
return { "ADMITTED" }
`;

/** A stale owner can never delete a successor lease or its project entry. */
export const MANUAL_RUN_RELEASE_LUA = `${ADMISSION_VALIDITY_LUA}
-- MANUAL_RUN_RELEASE
local ownerToken = ARGV[1]
if redis.call("GET", KEYS[1]) == ownerToken then
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[2], ownerToken)
end
return { "ADMITTED" }
`;

function replyValue(reply: unknown): string | undefined {
  return Array.isArray(reply) && typeof reply[0] === "string" ? reply[0] : undefined;
}

function serverTimeMs(reply: unknown): number | undefined {
  if (!Array.isArray(reply) || reply.length !== 2) return undefined;
  const [seconds, microseconds] = reply;
  if ((typeof seconds !== "string" && typeof seconds !== "number") || (typeof microseconds !== "string" && typeof microseconds !== "number")) return undefined;
  const parsedSeconds = Number(seconds);
  const parsedMicroseconds = Number(microseconds);
  if (!Number.isSafeInteger(parsedSeconds) || !Number.isSafeInteger(parsedMicroseconds) || parsedSeconds < 0 || parsedMicroseconds < 0 || parsedMicroseconds >= 1_000_000) return undefined;
  const milliseconds = (parsedSeconds * 1_000) + Math.floor(parsedMicroseconds / 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function waitForReply<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => resolve(value),
      () => resolve(undefined),
    ).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

/**
 * A client timeout is never treated as admission because Redis might still run
 * a command. The required server-side Lua guard makes that late command safe.
 */
export function createAdmissionExecutor(options: AdmissionOptions) {
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const operationTimeoutMs = options.operationTimeoutMs ?? COORDINATION_OPERATION_TIMEOUT_MS;

  return async function execute(script: string, keys: readonly string[], args: readonly string[]): Promise<AdmissionAttempt> {
    if (!script.startsWith(ADMISSION_VALIDITY_LUA)) return { kind: "unavailable" };
    const localDeadline = monotonicNow() + operationTimeoutMs;
    const remaining = () => Math.max(0, Math.floor(localDeadline - monotonicNow()));
    let client: RedisScriptClient | undefined;
    const unavailable = (): AdmissionAttempt => {
      if (client) {
        try {
          options.discardClient?.(client);
        } catch {
          // Closing an uncertain connection must not turn an admission into success.
        }
      } else {
        options.discardPendingClient?.();
      }
      return { kind: "unavailable" };
    };
    try {
      client = await waitForReply(options.getClient(), remaining());
      if (!client || remaining() === 0) return unavailable();
      const redisNow = serverTimeMs(await waitForReply(client.time(), remaining()));
      if (redisNow === undefined || remaining() === 0) return unavailable();
      const validity: AdmissionValidity = { serverDeadlineMs: redisNow + remaining() };
      const result = await waitForReply(
        client.eval(script, keys.length, ...keys, ...args, String(validity.serverDeadlineMs)),
        remaining(),
      );
      if (remaining() === 0) return unavailable();
      const reply = replyValue(result);
      if (reply === "ADMISSION_EXPIRED") return { kind: "expired" };
      if (reply === "ADMITTED") return { kind: "accepted" };
      if (reply === "RUN_IN_PROGRESS") return { kind: "in_progress" };
      if (reply === "RUN_COOLDOWN") return { kind: "cooldown" };
      if (reply === "PROJECT_CAPACITY") return { kind: "project_capacity" };
      return unavailable();
    } catch {
      return unavailable();
    }
  };
}

/**
 * Coordinator used by the future Route Handler. It deliberately exposes only
 * opaque owner tokens and never makes a Redis uncertainty look authorized.
 */
export function createManualRunCoordinator(options: ManualRunCoordinatorOptions) {
  return createManualRunCoordinatorFromExecutor(createAdmissionExecutor(options), options.ownerToken);
}

function createManualRunCoordinatorFromExecutor(
  execute: (script: string, keys: readonly string[], args: readonly string[]) => Promise<AdmissionAttempt>,
  createOwnerToken: (() => string) | undefined,
) {
  const ownerToken = createOwnerToken ?? randomUUID;

  return {
    async acquire(identity: ManualRunIdentity): Promise<ManualRunAdmission> {
      const token = ownerToken();
      const keys = coordinationKeys(identity);
      const result = await execute(MANUAL_RUN_ACQUIRE_LUA, [keys.lease, keys.cooldown, keys.projectLeases], [
        token,
        String(MANUAL_RUN_LEASE_TTL_MS),
        String(MANUAL_RUN_COOLDOWN_MS),
        String(MANUAL_RUN_PROJECT_CAPACITY),
      ]);
      return result.kind === "accepted" ? { kind: "admitted", ownerToken: token } : result;
    },
    async release(input: ManualRunReleaseInput): Promise<ManualRunRelease> {
      const keys = coordinationKeys(input);
      const result = await execute(MANUAL_RUN_RELEASE_LUA, [keys.lease, keys.projectLeases], [input.ownerToken]);
      return result.kind === "accepted" ? { kind: "released" } : { kind: "unavailable" };
    },
  };
}

/** Production composition keeps the constrained Redis connection server-only. */
export function createProductionManualRunCoordinator(options: ProductionManualRunCoordinatorOptions = {}) {
  return createManualRunCoordinatorFromExecutor(createProductionAdmissionExecutor(options), options.ownerToken);
}

/**
 * Builds a bounded, non-queueing production dependency for PR1B. An uncertain
 * client is discarded immediately; the next independent admission gets a new
 * connection and its own bounded window. The old command is never resent.
 */
export function createProductionAdmissionExecutor(options: ProductionAdmissionOptions = {}) {
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const createClient = options.createClient ?? createManualRunRedisConnection;
  let client: RedisScriptClient | undefined;
  let connected = false;
  let connecting: Promise<RedisScriptClient> | undefined;

  return createAdmissionExecutor({
    discardClient: (discardedClient) => {
      if (client !== discardedClient) return;
      client = undefined;
      connected = false;
      connecting = undefined;
      try {
        void Promise.resolve(discardedClient.disconnect?.()).catch(() => undefined);
      } catch {
        // The next independent admission still creates a bounded fresh client.
      }
    },
    discardPendingClient: () => {
      if (client) {
        const pendingClient = client;
        client = undefined;
        connected = false;
        connecting = undefined;
        try {
          void Promise.resolve(pendingClient.disconnect?.()).catch(() => undefined);
        } catch {
          // The next independent admission still creates a bounded fresh client.
        }
      }
    },
    monotonicNow: options.monotonicNow,
    operationTimeoutMs: options.operationTimeoutMs,
    getClient: async () => {
      if (!redisUrl) throw new Error("Redis unavailable");
      if (client && connected) return client;
      if (connecting) return connecting;
      const candidate = client ?? createClient(redisUrl);
      client = candidate;
      const pending = (async () => {
        await candidate.connect?.();
        if (client !== candidate) throw new Error("Redis client discarded");
        connected = true;
        return candidate;
      })();
      connecting = pending;
      try {
        return await pending;
      } finally {
        if (connecting === pending) connecting = undefined;
      }
    },
  });
}

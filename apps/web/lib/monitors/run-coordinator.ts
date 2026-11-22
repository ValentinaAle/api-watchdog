import "server-only";

import { createManualRunRedisConnection } from "@api-watchdog/queue";

export const COORDINATION_OPERATION_TIMEOUT_MS = 2_000;

export type RedisScriptClient = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  time(): Promise<readonly (string | number)[]>;
};

export type AdmissionValidity = Readonly<{ serverDeadlineMs: number }>;

export type AdmissionAttempt =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "unavailable" }>;

type AdmissionOptions = Readonly<{
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
    try {
      const client = await waitForReply(options.getClient(), remaining());
      if (!client || remaining() === 0) return { kind: "unavailable" };
      const redisNow = serverTimeMs(await waitForReply(client.time(), remaining()));
      if (redisNow === undefined || remaining() === 0) return { kind: "unavailable" };
      const validity: AdmissionValidity = { serverDeadlineMs: redisNow + remaining() };
      const result = await waitForReply(
        client.eval(script, keys.length, ...keys, ...args, String(validity.serverDeadlineMs)),
        remaining(),
      );
      if (remaining() === 0) return { kind: "unavailable" };
      const reply = replyValue(result);
      if (reply === "ADMISSION_EXPIRED") return { kind: "expired" };
      if (reply === "ADMITTED") return { kind: "accepted" };
      return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  };
}

/**
 * Builds a bounded, non-queueing production dependency for PR1B. A client
 * that disconnects after creation stays unavailable for this process instance:
 * it is deliberately not retried or replaced because an uncertain command
 * must never gain a later admission window.
 */
export function createProductionAdmissionExecutor(options: ProductionAdmissionOptions = {}) {
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const createClient = options.createClient ?? createManualRunRedisConnection;
  let client: RedisScriptClient | undefined;
  let unavailable = !redisUrl;

  return createAdmissionExecutor({
    monotonicNow: options.monotonicNow,
    operationTimeoutMs: options.operationTimeoutMs,
    getClient: async () => {
      if (unavailable || !redisUrl) throw new Error("Redis unavailable");
      try {
        const currentClient = client ?? createClient(redisUrl);
        client = currentClient;
        return currentClient;
      } catch {
        unavailable = true;
        throw new Error("Redis unavailable");
      }
    },
  });
}

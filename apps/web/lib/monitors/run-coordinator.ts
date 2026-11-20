import { createManualRunRedisConnection } from "@api-watchdog/queue";

export const COORDINATION_OPERATION_TIMEOUT_MS = 2_000;

export type RedisScriptClient = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};

export type AdmissionValidity = Readonly<{ deadlineMs: number }>;

export type AdmissionAttempt =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "unavailable" }>;

type AdmissionOptions = Readonly<{
  getClient: () => Promise<RedisScriptClient>;
  now?: () => number;
  operationTimeoutMs?: number;
}>;

type ProductionAdmissionOptions = Readonly<{
  redisUrl?: string;
  createClient?: (redisUrl: string) => RedisScriptClient;
  now?: () => number;
  operationTimeoutMs?: number;
}>;

/**
 * PR1B appends its atomic lease/cooldown/capacity mutations after this guard.
 * Redis evaluates TIME inside the script, so a command that reached Redis only
 * after the caller's admission window cannot mutate coordination state.
 */
export const ADMISSION_VALIDITY_LUA = `
local validityDeadlineMs = tonumber(ARGV[#ARGV])
local redisTime = redis.call("TIME")
local redisNowMs = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
if redisNowMs > validityDeadlineMs then
  return { "ADMISSION_EXPIRED" }
end
`;

function replyValue(reply: unknown): string | undefined {
  return Array.isArray(reply) && typeof reply[0] === "string" ? reply[0] : undefined;
}

function operationDeadline(now: () => number, operationTimeoutMs: number): AdmissionValidity {
  return { deadlineMs: now() + operationTimeoutMs };
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
  const now = options.now ?? Date.now;
  const operationTimeoutMs = options.operationTimeoutMs ?? COORDINATION_OPERATION_TIMEOUT_MS;

  return async function execute(script: string, keys: readonly string[], args: readonly string[]): Promise<AdmissionAttempt> {
    if (!script.startsWith(ADMISSION_VALIDITY_LUA)) return { kind: "unavailable" };
    const validity = operationDeadline(now, operationTimeoutMs);
    const remaining = () => Math.max(0, validity.deadlineMs - now());
    try {
      const client = await waitForReply(options.getClient(), remaining());
      if (!client || remaining() === 0) return { kind: "unavailable" };
      const reply = replyValue(await waitForReply(
        client.eval(script, keys.length, ...keys, ...args, String(validity.deadlineMs)),
        remaining(),
      ));
      if (reply === "ADMISSION_EXPIRED") return { kind: "expired" };
      if (reply === "ADMITTED") return { kind: "accepted" };
      return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  };
}

/** Builds a bounded, non-queueing production dependency for PR1B. */
export function createProductionAdmissionExecutor(options: ProductionAdmissionOptions = {}) {
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const createClient = options.createClient ?? createManualRunRedisConnection;
  let client: RedisScriptClient | undefined;
  let unavailable = !redisUrl;

  return createAdmissionExecutor({
    now: options.now,
    operationTimeoutMs: options.operationTimeoutMs,
    getClient: async () => {
      if (unavailable || !redisUrl) throw new Error("Redis unavailable");
      try {
        client ??= createClient(redisUrl);
        return client;
      } catch {
        unavailable = true;
        throw new Error("Redis unavailable");
      }
    },
  });
}

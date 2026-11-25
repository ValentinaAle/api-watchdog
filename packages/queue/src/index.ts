import { Queue, type ConnectionOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { QUEUE_NAME } from "@api-watchdog/shared";

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * This profile is only for one-off manual-run coordination. A command that
 * loses its connection or reply is indeterminate and must fail closed rather
 * than queueing or retrying into a later admission window.
 */
export const MANUAL_RUN_REDIS_OPTIONS: Readonly<RedisOptions> = {
  autoResendUnfulfilledCommands: false,
  commandTimeout: 2_000,
  connectTimeout: 2_000,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  socketTimeout: 2_000,
};

export function createManualRunRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, MANUAL_RUN_REDIS_OPTIONS);
}

export function createQueue(connection: ConnectionOptions) {
  return new Queue(QUEUE_NAME, { connection });
}

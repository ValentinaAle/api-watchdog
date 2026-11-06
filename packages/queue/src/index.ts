import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME } from "@api-watchdog/shared";

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createQueue(connection: ConnectionOptions) {
  return new Queue(QUEUE_NAME, { connection });
}

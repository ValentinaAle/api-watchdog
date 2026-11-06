import { createQueue, createRedisConnection } from "@api-watchdog/queue";
import { FOUNDATION_PING_JOB, type FoundationPingJob } from "@api-watchdog/shared";
import { validateEnvironment } from "@api-watchdog/validation";

const env = validateEnvironment(process.env);
const connection = createRedisConnection(env.REDIS_URL);
const queue = createQueue(connection);

async function enqueuePing() {
  const data: FoundationPingJob = { enqueuedAt: new Date().toISOString() };
  await queue.add(FOUNDATION_PING_JOB, data, { jobId: `foundation-ping-${Math.floor(Date.now() / 60_000)}`, removeOnComplete: 100, removeOnFail: 100 });
  console.info("Foundation ping enqueued");
}

await enqueuePing();
setInterval(() => void enqueuePing().catch(() => console.error("Unable to enqueue foundation ping")), 60_000);
console.info("Scheduler started");

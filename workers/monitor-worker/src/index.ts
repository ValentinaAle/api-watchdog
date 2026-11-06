import { Worker } from "bullmq";
import { createRedisConnection } from "@api-watchdog/queue";
import { FOUNDATION_PING_JOB, QUEUE_NAME, type FoundationPingJob } from "@api-watchdog/shared";
import { validateEnvironment } from "@api-watchdog/validation";

const env = validateEnvironment(process.env);
const connection = createRedisConnection(env.REDIS_URL);
const worker = new Worker<FoundationPingJob>(QUEUE_NAME, async (job) => {
  if (job.name !== FOUNDATION_PING_JOB) throw new Error("Unsupported job type");
  console.info("Processed foundation ping", { jobId: job.id });
}, { connection });

worker.on("failed", (job, error) => console.error("Job failed", { jobId: job?.id, message: error.message }));
console.info("Monitoring worker started");

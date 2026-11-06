import { NextResponse } from "next/server";
import { prisma } from "@api-watchdog/database";
import { createRedisConnection } from "@api-watchdog/queue";
import { validateEnvironment } from "@api-watchdog/validation";

export const runtime = "nodejs";

export async function GET() {
  try {
    const env = validateEnvironment(process.env);
    const redis = createRedisConnection(env.REDIS_URL);
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    await redis.quit();
    return NextResponse.json({ status: "ok", services: { database: "ok", redis: "ok" } });
  } catch {
    return NextResponse.json({ status: "unhealthy" }, { status: 503 });
  }
}

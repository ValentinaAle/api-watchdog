-- CreateEnum
CREATE TYPE "CheckResultSource" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "CheckOutcome" AS ENUM ('SUCCESS', 'UNEXPECTED_STATUS', 'DNS_FAILURE', 'CONNECTION_FAILURE', 'TLS_OR_PROTOCOL_FAILURE', 'TIMEOUT', 'RESPONSE_LIMIT');

-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "source" "CheckResultSource" NOT NULL,
    "outcome" "CheckOutcome" NOT NULL,
    "statusCode" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "errorCode" VARCHAR(64),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_executionId_key" ON "CheckResult"("executionId");

-- CreateIndex
CREATE INDEX "CheckResult_monitorId_finishedAt_idx" ON "CheckResult"("monitorId", "finishedAt");

-- CreateIndex
CREATE INDEX "CheckResult_finishedAt_idx" ON "CheckResult"("finishedAt");

-- CreateIndex
CREATE INDEX "Monitor_status_id_idx" ON "Monitor"("status", "id");

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

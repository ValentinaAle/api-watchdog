import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../packages/database/src/index.ts";

const projectIds: string[] = [];

async function createProject(name: string): Promise<string> {
  const project = await prisma.project.create({ data: { name } });
  projectIds.push(project.id);
  return project.id;
}

async function createMonitor(projectId: string, name: string) {
  return prisma.monitor.create({
    data: {
      project: { connect: { id: projectId } },
      name,
      url: "https://example.com/health",
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 5_000,
      expectedStatus: 200,
      status: "ACTIVE",
    },
  });
}

async function cleanProjects() {
  const ids = projectIds.splice(0);
  if (ids.length === 0) return;
  await prisma.monitor.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.project.deleteMany({ where: { id: { in: ids } } });
}

function resultInput(monitorId: string, executionId: string, source: "MANUAL" | "SCHEDULED") {
  return {
    monitorId,
    executionId,
    source,
    outcome: "SUCCESS",
    statusCode: 200,
    latencyMs: 42,
    errorCode: null,
    startedAt: new Date("2026-11-26T00:00:00.000Z"),
    finishedAt: new Date("2026-11-26T00:00:00.042Z"),
  };
}

describe("CheckResult schema migration", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL_TEST) {
      throw new Error("DATABASE_URL_TEST is required; run through the isolated integration harness.");
    }
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanProjects();
  });

  afterAll(async () => {
    await cleanProjects().catch(() => undefined);
    await prisma.$disconnect();
  });

  it("gives existing and new monitors scheduleVersion 1", async () => {
    const projectId = await createProject("schedule-version");
    const monitor = await createMonitor(projectId, "existing-compatible-monitor");

    expect(monitor.expectedStatus).toBe(200);
    expect(monitor.scheduleVersion).toBe(1);
  });

  it.each(["MANUAL", "SCHEDULED"] as const)("creates a redacted %s CheckResult with nullable optional fields", async (source) => {
    const projectId = await createProject(`result-${source}`);
    const monitor = await createMonitor(projectId, `monitor-${source}`);

    const result = await prisma.checkResult.create({
      data: {
        ...resultInput(monitor.id, `${source.toLowerCase()}-execution`, source),
        statusCode: null,
        errorCode: "DNS_FAILURE",
      },
    });

    expect(result).toMatchObject({ monitorId: monitor.id, source, statusCode: null, errorCode: "DNS_FAILURE" });
    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("body");
  });

  it("rejects a duplicate executionId", async () => {
    const projectId = await createProject("unique-execution");
    const monitor = await createMonitor(projectId, "unique-monitor");
    const data = resultInput(monitor.id, "same-logical-execution", "SCHEDULED");

    await prisma.checkResult.create({ data });
    await expect(prisma.checkResult.create({ data })).rejects.toThrow();
  });

  it("rejects a result for an absent monitor", async () => {
    await expect(prisma.checkResult.create({
      data: resultInput("cmissingmonitor0000000000000", "orphan-execution", "MANUAL"),
    })).rejects.toThrow();
  });

  it("cascades only the deleted monitor's results", async () => {
    const projectId = await createProject("cascade");
    const first = await createMonitor(projectId, "first-monitor");
    const second = await createMonitor(projectId, "second-monitor");
    await prisma.checkResult.create({ data: resultInput(first.id, "first-execution", "MANUAL") });
    await prisma.checkResult.create({ data: resultInput(second.id, "second-execution", "SCHEDULED") });

    await prisma.monitor.delete({ where: { id: first.id } });

    await expect(prisma.checkResult.count({ where: { monitorId: first.id } })).resolves.toBe(0);
    await expect(prisma.checkResult.count({ where: { monitorId: second.id } })).resolves.toBe(1);
  });

  it("creates the monitor/finalization indexes required for future reads and retention", async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CheckResult'
    `;
    const names = indexes.map(({ indexname }) => indexname);
    expect(names).toContain("CheckResult_monitorId_finishedAt_idx");
    expect(names).toContain("CheckResult_finishedAt_idx");
  });
});

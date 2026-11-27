import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../packages/database/src/index.ts";
import { createMonitor, getMonitor, updateMonitor } from "../../packages/database/src/monitors.ts";

const projectIds: string[] = [];

async function project(name: string) {
  const value = await prisma.project.create({ data: { name } });
  projectIds.push(value.id);
  return value;
}

async function monitor(projectId: string, name = "monitor") {
  return createMonitor({
    projectId,
    name,
    url: "https://example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 5_000,
    expectedStatus: 200,
    status: "ACTIVE",
  });
}

async function clean() {
  const ids = projectIds.splice(0);
  if (!ids.length) return;
  await prisma.monitor.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.project.deleteMany({ where: { id: { in: ids } } });
}

describe("Monitor scheduleVersion updates", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL_TEST) throw new Error("DATABASE_URL_TEST is required");
    await prisma.$connect();
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean().catch(() => undefined);
    await prisma.$disconnect();
  });

  it("starts each new monitor at version 1", async () => {
    const p = await project("schedule-initial");
    await expect(monitor(p.id)).resolves.toMatchObject({ scheduleVersion: 1 });
  });

  it.each([
    ["url", { url: "https://example.org/health" }],
    ["method", { method: "HEAD" as const }],
    ["intervalSeconds", { intervalSeconds: 90 }],
    ["timeoutMs", { timeoutMs: 6_000 }],
    ["expectedStatus", { expectedStatus: 201 }],
    ["status", { status: "PAUSED" as const }],
  ])("increments exactly once for an effective %s change", async (_field, input) => {
    const p = await project(`schedule-${_field}`);
    const current = await monitor(p.id);
    await expect(updateMonitor(p.id, current.id, input)).resolves.toMatchObject({ scheduleVersion: 2, ...input });
  });

  it("increments once when multiple operational fields change together", async () => {
    const p = await project("schedule-many");
    const current = await monitor(p.id);
    await expect(updateMonitor(p.id, current.id, {
      intervalSeconds: 120,
      timeoutMs: 7_000,
      expectedStatus: 204,
    })).resolves.toMatchObject({ scheduleVersion: 2, intervalSeconds: 120, timeoutMs: 7_000, expectedStatus: 204 });
  });

  it("does not increment for a name-only or no-op update", async () => {
    const p = await project("schedule-descriptive");
    const current = await monitor(p.id);
    await expect(updateMonitor(p.id, current.id, { name: "renamed" })).resolves.toMatchObject({ scheduleVersion: 1, name: "renamed" });
    await expect(updateMonitor(p.id, current.id, { name: "renamed", intervalSeconds: 60 })).resolves.toMatchObject({ scheduleVersion: 1 });
  });

  it("increments only for effective pause and resume transitions", async () => {
    const p = await project("schedule-status");
    const current = await monitor(p.id);
    await expect(updateMonitor(p.id, current.id, { status: "PAUSED" })).resolves.toMatchObject({ scheduleVersion: 2, status: "PAUSED" });
    await expect(updateMonitor(p.id, current.id, { status: "PAUSED" })).resolves.toMatchObject({ scheduleVersion: 2 });
    await expect(updateMonitor(p.id, current.id, { status: "ACTIVE" })).resolves.toMatchObject({ scheduleVersion: 3, status: "ACTIVE" });
  });

  it("preserves both concurrent operational changes and increments twice", async () => {
    const p = await project("schedule-concurrent-operational");
    const current = await monitor(p.id);
    await Promise.all([
      updateMonitor(p.id, current.id, { intervalSeconds: 120 }),
      updateMonitor(p.id, current.id, { timeoutMs: 7_000 }),
    ]);
    await expect(getMonitor(p.id, current.id)).resolves.toMatchObject({ intervalSeconds: 120, timeoutMs: 7_000, scheduleVersion: 3 });
  });

  it("deduplicates concurrent equivalent operational changes", async () => {
    const p = await project("schedule-concurrent-same");
    const current = await monitor(p.id);
    await Promise.all([
      updateMonitor(p.id, current.id, { expectedStatus: 201 }),
      updateMonitor(p.id, current.id, { expectedStatus: 201 }),
    ]);
    await expect(getMonitor(p.id, current.id)).resolves.toMatchObject({ expectedStatus: 201, scheduleVersion: 2 });
  });

  it("keeps concurrent pause/resume transitions version-consistent", async () => {
    const p = await project("schedule-concurrent-status");
    const current = await monitor(p.id);
    await updateMonitor(p.id, current.id, { status: "PAUSED" });
    await Promise.all([
      updateMonitor(p.id, current.id, { status: "PAUSED" }),
      updateMonitor(p.id, current.id, { status: "ACTIVE" }),
    ]);
    const final = await getMonitor(p.id, current.id);
    expect(final).not.toBeNull();
    expect([
      { status: "ACTIVE", scheduleVersion: 3 },
      { status: "PAUSED", scheduleVersion: 4 },
    ]).toContainEqual({ status: final?.status, scheduleVersion: final?.scheduleVersion });
  });

  it("does not let a descriptive concurrent update overwrite scheduleVersion", async () => {
    const p = await project("schedule-concurrent-name");
    const current = await monitor(p.id);
    await Promise.all([
      updateMonitor(p.id, current.id, { name: "descriptive" }),
      updateMonitor(p.id, current.id, { method: "HEAD" }),
    ]);
    await expect(getMonitor(p.id, current.id)).resolves.toMatchObject({ name: "descriptive", method: "HEAD", scheduleVersion: 2 });
  });

  it("does not increment when the atomic update fails", async () => {
    const p = await project("schedule-failure");
    const current = await monitor(p.id);
    await expect(updateMonitor(p.id, current.id, { name: "x".repeat(101), intervalSeconds: 120 })).rejects.toThrow();
    await expect(getMonitor(p.id, current.id)).resolves.toMatchObject({ name: "monitor", intervalSeconds: 60, scheduleVersion: 1 });
  });

  it("preserves project isolation", async () => {
    const owner = await project("schedule-owner");
    const other = await project("schedule-other");
    const current = await monitor(owner.id);
    await expect(updateMonitor(other.id, current.id, { timeoutMs: 7_000 })).resolves.toBeNull();
    await expect(getMonitor(owner.id, current.id)).resolves.toMatchObject({ timeoutMs: 5_000, scheduleVersion: 1 });
  });
});

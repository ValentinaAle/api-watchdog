import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../packages/database/src/index.ts";

type MonitorStatus = "ACTIVE" | "PAUSED";
type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

type MonitorInput = {
  projectId: string;
  name: string;
  url: string;
  method: HttpMethod;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number;
  status: MonitorStatus;
};

type MonitorRecord = MonitorInput & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

type MonitorRepository = {
  createMonitor(input: MonitorInput): Promise<MonitorRecord>;
  listMonitors(projectId: string): Promise<MonitorRecord[]>;
  getMonitor(projectId: string, monitorId: string): Promise<MonitorRecord | null>;
  updateMonitor(
    projectId: string,
    monitorId: string,
    input: Partial<Omit<MonitorInput, "projectId">>,
  ): Promise<MonitorRecord | null>;
  deleteMonitor(projectId: string, monitorId: string): Promise<boolean>;
};

const db = prisma as typeof prisma & {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

const projectIds: string[] = [];
const repositoryPath = fileURLToPath(new URL("../../packages/database/src/monitors.ts", import.meta.url));
let repository: MonitorRepository | undefined;
let repositoryLoadFailure: unknown;

if (existsSync(repositoryPath)) {
  try {
    // Keep the repository optional at test-collection time so RED is a test assertion,
    // not a TypeScript or module-resolution failure before the Monitor slice exists.
    repository = (await import(/* @vite-ignore */ pathToFileURL(repositoryPath).href)) as MonitorRepository;
  } catch (error) {
    repositoryLoadFailure = error;
  }
}

function requireRepository(): MonitorRepository {
  expect(
    repository,
    `Monitor repository is not available yet${repositoryLoadFailure ? `: ${String(repositoryLoadFailure)}` : ""}`,
  ).toBeDefined();
  return repository!;
}

function monitorInput(projectId: string, name = "integration monitor"): MonitorInput {
  return {
    projectId,
    name,
    url: "https://example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 5_000,
    expectedStatus: 200,
    status: "ACTIVE",
  };
}

async function createProject(name: string): Promise<string> {
  const project = await prisma.project.create({ data: { name } });
  projectIds.push(project.id);
  return project.id;
}

async function cleanTestProjects(): Promise<void> {
  const ids = projectIds.splice(0);
  if (ids.length === 0) return;

  await prisma.monitor.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.project.deleteMany({ where: { id: { in: ids } } });
}

describe("project-scoped Monitor persistence", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL_TEST) {
      throw new Error("DATABASE_URL_TEST is required; run via pnpm test:integration so the isolated test-database guard executes.");
    }
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanTestProjects();
  });

  afterAll(async () => {
    await cleanTestProjects().catch(() => undefined);
    await prisma.$disconnect();
  });

  it("requires an existing project and persists ownership through the required projectId relation", async () => {
    const repo = requireRepository();
    const projectId = await createProject("monitor-owner");

    const created = await repo.createMonitor(monitorInput(projectId));
    expect(created.projectId).toBe(projectId);
    expect(await repo.getMonitor(projectId, created.id)).toMatchObject({ id: created.id, projectId });
    await expect(repo.createMonitor(monitorInput("missing-project-id"))).rejects.toThrow();
  });

  it("lists only monitors owned by the selected project in deterministic newest-first order", async () => {
    const repo = requireRepository();
    const projectA = await createProject("monitor-list-a");
    const projectB = await createProject("monitor-list-b");
    const first = await repo.createMonitor(monitorInput(projectA, "first"));
    const second = await repo.createMonitor(monitorInput(projectA, "second"));
    await repo.createMonitor(monitorInput(projectB, "other project"));

    const tiedTimestamp = new Date("2026-01-02T03:04:05.000Z");
    await db.$executeRawUnsafe(
      'UPDATE "Monitor" SET "createdAt" = $1 WHERE "id" IN ($2, $3)',
      tiedTimestamp,
      first.id,
      second.id,
    );

    const listed = await repo.listMonitors(projectA);
    const expectedTieOrder = [first.id, second.id].sort((a, b) => b.localeCompare(a));
    expect(listed.map(({ id }) => id)).toEqual(expectedTieOrder);
    expect(listed.every(({ projectId }) => projectId === projectA)).toBe(true);
  });

  it("scopes read, update, and delete by both projectId and monitor id without disclosing foreign rows", async () => {
    const repo = requireRepository();
    const ownerProject = await createProject("monitor-scope-owner");
    const otherProject = await createProject("monitor-scope-other");
    const monitor = await repo.createMonitor(monitorInput(ownerProject));

    expect(await repo.getMonitor(otherProject, monitor.id)).toBeNull();
    expect(await repo.updateMonitor(otherProject, monitor.id, { name: "must not update" })).toBeNull();
    expect(await repo.deleteMonitor(otherProject, monitor.id)).toBe(false);
    expect(await repo.getMonitor(ownerProject, monitor.id)).toMatchObject({ name: "integration monitor" });
  });

  it("updates and hard-deletes a monitor only within its owning project", async () => {
    const repo = requireRepository();
    const projectId = await createProject("monitor-mutation-owner");
    const monitor = await repo.createMonitor(monitorInput(projectId));

    expect(await repo.updateMonitor(projectId, monitor.id, { status: "PAUSED" })).toMatchObject({ status: "PAUSED" });
    expect(await repo.deleteMonitor(projectId, monitor.id)).toBe(true);
    expect(await repo.getMonitor(projectId, monitor.id)).toBeNull();
  });

  it("prevents deleting a Project while it owns monitors", async () => {
    const repo = requireRepository();
    const projectId = await createProject("monitor-restrict-project-delete");
    await repo.createMonitor(monitorInput(projectId));

    await expect(prisma.project.delete({ where: { id: projectId } })).rejects.toThrow();
  });
});

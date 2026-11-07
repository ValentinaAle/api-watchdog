import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../packages/database/src/index.ts";
import { createMonitorCollectionHandlers } from "../../apps/web/lib/monitors/collection.ts";

const projectIds: string[] = [];
const resolver = {
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => ["2606:2800:220:1:248:1893:25c8:1946"]),
};
const collection = createMonitorCollectionHandlers({ resolver });
const testFetch = vi.spyOn(globalThis, "fetch");

function input(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "API monitor",
    url: "https://example.com/health?check=1",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 5_000,
    expectedStatus: 200,
    status: "active",
    ...overrides,
  };
}

async function makeProject(name: string): Promise<string> {
  const project = await prisma.project.create({ data: { name } });
  projectIds.push(project.id);
  return project.id;
}

async function cleanProjects(): Promise<void> {
  const ids = projectIds.splice(0);
  if (!ids.length) return;
  await prisma.monitor.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.project.deleteMany({ where: { id: { in: ids } } });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("project-scoped monitor collection API", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL_TEST) {
      throw new Error("DATABASE_URL_TEST is required; use pnpm test:integration.");
    }
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanProjects();
    resolver.resolve4.mockClear();
    resolver.resolve6.mockClear();
    testFetch.mockClear();
  });

  afterAll(async () => {
    await cleanProjects().catch(() => undefined);
    testFetch.mockRestore();
    await prisma.$disconnect();
  });

  it("creates and lists only monitors in the requested project with safe no-store responses", async () => {
    const projectId = await makeProject("api-list-project");
    const otherProjectId = await makeProject("api-other-project");
    const created = await collection.POST(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input()), headers: { "content-type": "application/json" },
    }), { projectId });

    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toMatch(new RegExp(`/api/projects/${projectId}/monitors/c[a-z0-9]{24}$`));
    const createdBody = await json(created);
    expect(createdBody.data).toMatchObject({ projectId, name: "API monitor", status: "active" });
    expect(createdBody.data.url).toBe("https://example.com/health?check=1");

    const ownList = await collection.GET(new Request("http://localhost"), { projectId });
    const otherList = await collection.GET(new Request("http://localhost"), { projectId: otherProjectId });
    expect(ownList.headers.get("cache-control")).toBe("no-store");
    expect((await json(ownList)).data).toHaveLength(1);
    expect((await json(otherList)).data).toEqual([]);
    expect(resolver.resolve4).toHaveBeenCalledTimes(1);
    expect(resolver.resolve6).toHaveBeenCalledTimes(1);
  });

  it("admits new targets asynchronously before persistence and never fetches them", async () => {
    const projectId = await makeProject("api-admission-project");
    resolver.resolve4.mockResolvedValueOnce(["10.0.0.1"]);
    const unsafe = await collection.POST(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input()), headers: { "content-type": "application/json" },
    }), { projectId });
    expect(unsafe.status).toBe(422);
    expect(await json(unsafe)).toMatchObject({ error: { code: "UNSAFE_TARGET" } });
    expect((await collection.GET(new Request("http://localhost"), { projectId })).status).toBe(200);
    expect((await json(await collection.GET(new Request("http://localhost"), { projectId }))).data).toEqual([]);

    const created = await collection.POST(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input()), headers: { "content-type": "application/json" },
    }), { projectId });
    expect(created.status).toBe(201);
    expect(testFetch).not.toHaveBeenCalled();
  });

  it("returns safe collection errors for malformed JSON, invalid IDs, missing projects, and database failures", async () => {
    const projectId = await makeProject("api-safe-error-project");
    const malformedJson = await collection.POST(new Request("http://localhost", {
      method: "POST", body: "{", headers: { "content-type": "application/json" },
    }), { projectId });
    expect(malformedJson.status).toBe(400);
    expect((await json(malformedJson)).error).toMatchObject({ code: "INVALID_REQUEST" });

    const malformedId = await collection.GET(new Request("http://localhost"), { projectId: "not-an-id" });
    expect(malformedId.status).toBe(400);

    const missingProject = await collection.GET(new Request("http://localhost"), { projectId: "c000000000000000000000000" });
    expect(missingProject.status).toBe(404);
    expect((await json(missingProject)).error).toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const dbSpy = vi.spyOn(prisma.project, "findUnique").mockRejectedValueOnce(new Error("database password leaked"));
    const failed = await collection.GET(new Request("http://localhost"), { projectId });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await json(failed))).not.toContain("database password");
    dbSpy.mockRestore();
  });
});

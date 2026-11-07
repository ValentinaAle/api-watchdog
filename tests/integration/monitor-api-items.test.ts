import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../packages/database/src/index.ts";
import { createMonitorApi } from "../../apps/web/lib/monitors/index.ts";

const projectIds: string[] = [];
const resolver = {
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => ["2606:2800:220:1:248:1893:25c8:1946"]),
};
const api = createMonitorApi({ resolver });
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

describe("project-scoped monitor item and action API", () => {
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

  it("supports scoped item reads, config-only PATCH, and hard delete", async () => {
    const projectId = await makeProject("api-item-project");
    const otherProjectId = await makeProject("api-foreign-project");
    const createdResponse = await api.collection.POST(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input()), headers: { "content-type": "application/json" },
    }), { projectId });
    const monitor = (await json(createdResponse)).data;

    const item = { projectId, monitorId: monitor.id };
    const get = await api.item.GET(new Request("http://localhost"), item);
    expect((await json(get)).data.id).toBe(monitor.id);
    expect(get.headers.get("cache-control")).toBe("no-store");

    const patch = await api.item.PATCH(new Request("http://localhost", {
      method: "PATCH", body: JSON.stringify({ name: "Renamed" }),
      headers: { "content-type": "application/json" },
    }), item);
    expect((await json(patch)).data).toMatchObject({ name: "Renamed", status: "active" });
    expect(resolver.resolve4).toHaveBeenCalledTimes(1);

    const statusPatch = await api.item.PATCH(new Request("http://localhost", {
      method: "PATCH", body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    }), item);
    expect(statusPatch.status).toBe(400);

    const foreign = await api.item.GET(new Request("http://localhost"), { ...item, projectId: otherProjectId });
    expect(foreign.status).toBe(404);
    expect(await json(foreign)).toEqual(await json(await api.item.GET(new Request("http://localhost"), {
      projectId, monitorId: "c000000000000000000000000",
    })));
    expect((await api.item.PATCH(new Request("http://localhost", {
      method: "PATCH", body: JSON.stringify({ name: "Must not leak" }),
      headers: { "content-type": "application/json" },
    }), { ...item, projectId: otherProjectId })).status).toBe(404);
    expect((await api.actions.pause(new Request("http://localhost", { method: "POST" }), {
      ...item, projectId: otherProjectId,
    })).status).toBe(404);
    expect((await api.item.GET(new Request("http://localhost"), item)).status).toBe(200);
    expect((await api.item.DELETE(new Request("http://localhost"), { ...item, projectId: otherProjectId })).status).toBe(404);

    const deleted = await api.item.DELETE(new Request("http://localhost"), item);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect((await api.item.GET(new Request("http://localhost"), item)).status).toBe(404);
  });

  it("re-admits a changed URL before persistence and never fetches the target", async () => {
    const projectId = await makeProject("api-admission-project");
    const created = await api.collection.POST(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input()), headers: { "content-type": "application/json" },
    }), { projectId });
    const monitor = (await json(created)).data;
    resolver.resolve4.mockResolvedValueOnce(["127.0.0.1"]);

    const urlUpdate = await api.item.PATCH(new Request("http://localhost", {
      method: "PATCH", body: JSON.stringify({ url: "https://example.com/new" }),
      headers: { "content-type": "application/json" },
    }), { projectId, monitorId: monitor.id });
    expect(urlUpdate.status).toBe(422);
    expect((await json(urlUpdate)).error.message).not.toContain("example.com");
    expect((await json(await api.item.GET(new Request("http://localhost"), {
      projectId, monitorId: monitor.id,
    }))).data.url).toBe("https://example.com/health?check=1");
    expect(testFetch).not.toHaveBeenCalled();
  });

  it("returns safe item errors for malformed IDs and missing monitors", async () => {
    const projectId = await makeProject("api-item-error-project");
    const malformedId = await api.item.GET(new Request("http://localhost"), {
      projectId: "not-an-id", monitorId: "also-invalid",
    });
    expect(malformedId.status).toBe(400);
    expect((await json(malformedId)).error).toMatchObject({ code: "INVALID_REQUEST" });

    const missing = await api.item.GET(new Request("http://localhost"), {
      projectId, monitorId: "c000000000000000000000000",
    });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toMatchObject({ code: "MONITOR_NOT_FOUND" });
  });

  it("performs pause/resume as safe scoped idempotent actions without scheduling work", async () => {
    const projectId = await makeProject("api-state-project");
    const otherProjectId = await makeProject("api-state-other");
    const created = await api.collection.POST(new Request("http://localhost", {
      method: "POST", body: JSON.stringify(input()), headers: { "content-type": "application/json" },
    }), { projectId });
    const monitorId = (await json(created)).data.id;
    const item = { projectId, monitorId };

    const pause = () => api.actions.pause(new Request("http://localhost", { method: "POST" }), item);
    const resume = () => api.actions.resume(new Request("http://localhost", { method: "POST" }), item);
    expect((await json(await pause())).data.status).toBe("paused");
    expect((await json(await pause())).data.status).toBe("paused");
    expect((await json(await resume())).data.status).toBe("active");
    expect((await json(await resume())).data.status).toBe("active");
    expect((await api.actions.pause(new Request("http://localhost"), { ...item, projectId: otherProjectId })).status).toBe(404);
    expect(testFetch).not.toHaveBeenCalled();
  });
});

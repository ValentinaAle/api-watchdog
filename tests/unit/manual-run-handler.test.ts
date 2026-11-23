import { describe, expect, it, vi } from "vitest";
import { createManualRunHandlers } from "../../apps/web/lib/monitors/run.ts";
import type { MonitorRecord } from "../../apps/web/lib/monitors/http.ts";

const monitor: MonitorRecord = { id: "cmwe7tp5p0000795g7n24brby", projectId: "cmwe7tp5p0000795g7n24brbz", name: "Demo", url: "https://monitor.test/secret?q=x", method: "GET", intervalSeconds: 60, timeoutMs: 1_000, expectedStatus: 200, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() };
function setup(overrides: Partial<Parameters<typeof createManualRunHandlers>[0]> = {}) {
  const repository = { get: vi.fn(async () => monitor) };
  const coordinator = { acquire: vi.fn(async () => ({ kind: "admitted" as const, ownerToken: "owner" })), release: vi.fn(async () => ({ kind: "released" as const })) };
  const execute = vi.fn(async () => ({ outcome: "success" as const, latencyMs: 8, statusCode: 200 }));
  const dependencies = { repository, coordinator, execute, ...overrides };
  return { repository: dependencies.repository as typeof repository, coordinator: dependencies.coordinator as typeof coordinator, execute: dependencies.execute as typeof execute, handler: createManualRunHandlers(dependencies) };
}
const params = { projectId: monitor.projectId, monitorId: monitor.id };

describe("manual run handler", () => {
  it("rejects invalid params, query and bodies before lookup", async () => {
    const { handler, repository, coordinator, execute } = setup();
    for (const request of [new Request("http://x/api?x=1", { method: "POST" }), new Request("http://x/api", { method: "POST", body: "{}" })]) {
      expect((await handler.POST(request, params)).status).toBe(400);
    }
    expect((await handler.POST(new Request("http://x/api", { method: "POST" }), { ...params, monitorId: "bad" })).status).toBe(400);
    expect(repository.get).not.toHaveBeenCalled(); expect(coordinator.acquire).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it("uses only a scoped lookup and makes absent/foreign monitors indistinguishable", async () => {
    const { handler, repository, coordinator, execute } = setup({ repository: { get: vi.fn(async () => null) } as never });
    const response = await handler.POST(new Request("http://x/api", { method: "POST" }), params);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: { code: "MONITOR_NOT_FOUND", message: "Monitor not found" } });
    expect(coordinator.acquire).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(repository.get).toHaveBeenCalledWith(params.projectId, params.monitorId);
  });
  it("executes a persisted PAUSED monitor without changing its state", async () => {
    const { handler, execute } = setup({ repository: { get: vi.fn(async () => ({ ...monitor, status: "PAUSED" as const })) } as never });
    expect((await handler.POST(new Request("http://x/api", { method: "POST" }), params)).status).toBe(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }), expect.any(AbortSignal));
  });
  it("acquires before executing, returns a redacted typed result, and releases once", async () => {
    const { handler, coordinator, execute } = setup();
    const response = await handler.POST(new Request("http://x/api", { method: "POST" }), params);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(await response.json()).toEqual({ data: { outcome: "success", latencyMs: 8, statusCode: 200 } });
    expect(execute).toHaveBeenCalledWith({ url: monitor.url, method: "GET", timeoutMs: 1_000, expectedStatus: 200 }, expect.any(AbortSignal)); expect(coordinator.release).toHaveBeenCalledTimes(1);
  });
  it("maps admission failures, unsupported stored OPTIONS, execution errors, and release errors safely", async () => {
    const unavailable = setup({ coordinator: { acquire: vi.fn(async () => ({ kind: "unavailable" as const })), release: vi.fn() } as never });
    expect((await unavailable.handler.POST(new Request("http://x/api", { method: "POST" }), params)).status).toBe(503); expect(unavailable.execute).not.toHaveBeenCalled();
    const options = setup({ repository: { get: vi.fn(async () => ({ ...monitor, method: "OPTIONS" })) } as never });
    expect((await options.handler.POST(new Request("http://x/api", { method: "POST" }), params)).status).toBe(500); expect(options.execute).not.toHaveBeenCalled();
    const failed = setup({ execute: vi.fn(async () => { throw new Error("https://secret/?token=bad"); }) as never, coordinator: { acquire: vi.fn(async () => ({ kind: "admitted" as const, ownerToken: "owner" })), release: vi.fn(async () => { throw new Error("redis://secret"); }) } as never });
    const response = await failed.handler.POST(new Request("http://x/api", { method: "POST" }), params);
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toMatch(/secret|token|redis/); expect(failed.coordinator.release).toHaveBeenCalledTimes(1);
  });
});

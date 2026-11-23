import { describe, expect, it, vi } from "vitest";
import { projectMonitorEditPath, projectMonitorPath, projectMonitorsPath } from "../../apps/web/lib/projects/paths";
import { normalizeProjectId } from "../../apps/web/lib/projects/project-id";
import {
  createManualRunClient,
  formatInterval,
  manualRunApiPath,
  monitorActionApiPath,
  monitorApiPath,
  parseManualRunResult,
} from "../../apps/web/components/monitors/types";

describe("monitor UI route and display helpers", () => {
  it("keeps every route explicitly scoped to the supplied project ID", () => {
    expect(projectMonitorsPath("c123")).toBe("/projects/c123/monitors");
    expect(monitorApiPath("c123")).toBe("/api/projects/c123/monitors");
    expect(monitorApiPath("c123", "m/1")).toBe("/api/projects/c123/monitors/m%2F1");
    expect(projectMonitorPath("c123", "m/1")).toBe("/projects/c123/monitors/m%2F1");
    expect(projectMonitorEditPath("c123", "m/1")).toBe("/projects/c123/monitors/m%2F1/edit");
  });

  it("encodes a decoded project ID once as a single path segment", () => {
    expect(projectMonitorsPath("Alpha & Beta/2026"))
      .toBe("/projects/Alpha%20%26%20Beta%2F2026/monitors");
  });

  it("normalizes a route value once and rejects malformed or placeholder values", () => {
    expect(normalizeProjectId("Alpha")).toBe("Alpha");
    expect(normalizeProjectId("Alpha%20%26%20Beta")).toBe("Alpha & Beta");
    expect(normalizeProjectId("Alpha%2FBeta")).toBe("Alpha/Beta");
    expect(normalizeProjectId("Alpha%20%26%20Beta%2F2026")).toBe("Alpha & Beta/2026");
    expect(normalizeProjectId("Alpha%20100%25")).toBe("Alpha 100%");
    expect(normalizeProjectId("Alpha%ZZ")).toBeUndefined();
    expect(normalizeProjectId("{projectId}")).toBeUndefined();
    expect(normalizeProjectId("%7BprojectId%7D")).toBeUndefined();
    expect(normalizeProjectId("%257BprojectId%257D")).toBeUndefined();
    const normalizedProjectId = normalizeProjectId("Alpha%20%26%20Beta%2F2026");
    expect(normalizedProjectId).toBe("Alpha & Beta/2026");
    expect(projectMonitorsPath(normalizedProjectId!))
      .toBe("/projects/Alpha%20%26%20Beta%2F2026/monitors");
  });

  it("formats the configured cadence without implying execution telemetry", () => {
    expect(formatInterval(30)).toBe("30 sec");
    expect(formatInterval(300)).toBe("5 min");
    expect(formatInterval(7200)).toBe("2 hr");
  });

  it("keeps pause and resume actions under the explicit project and monitor path", () => {
    expect(monitorActionApiPath("c123", "m456", "pause")).toBe("/api/projects/c123/monitors/m456/pause");
    expect(monitorActionApiPath("c123", "m456", "resume")).toBe("/api/projects/c123/monitors/m456/resume");
  });

  it("builds the bodyless Run Now endpoint with each decoded segment encoded once", () => {
    expect(manualRunApiPath("Alpha & Beta/2026", "monitor/one"))
      .toBe("/api/projects/Alpha%20%26%20Beta%2F2026/monitors/monitor%2Fone/run");
  });

  it("accepts only the redacted transient run-result shape", () => {
    expect(parseManualRunResult({ outcome: "success", latencyMs: 8, statusCode: 200 }))
      .toEqual({ outcome: "success", latencyMs: 8, statusCode: 200 });
    expect(parseManualRunResult({ outcome: "unexpected_status", latencyMs: 8 }))
      .toEqual({ outcome: "unexpected_status", latencyMs: 8 });
    expect(parseManualRunResult({ outcome: "success", latencyMs: 8, url: "https://secret.test" }))
      .toBeUndefined();
    expect(parseManualRunResult({ outcome: "unknown", latencyMs: 8 })).toBeUndefined();
  });

  it("prevents duplicate local runs, displays typed failures, and safely cleans up on dispose", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const states: Array<{ pending: boolean; result?: { outcome: string }; error?: string }> = [];
    const client = createManualRunClient({
      projectId: "project",
      monitorId: "monitor",
      fetcher,
      onStateChange: (state) => states.push(state),
    });

    const first = client.run();
    const duplicate = client.run();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/project/monitors/monitor/run", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(states.at(-1)).toMatchObject({ pending: true });

    resolveFetch!(new Response(JSON.stringify({ data: { outcome: "unexpected_status", latencyMs: 6, statusCode: 503 } }), { status: 200 }));
    await Promise.all([first, duplicate]);
    expect(states.at(-1)).toMatchObject({ pending: false, result: { outcome: "unexpected_status" } });

    const controller = createManualRunClient({ projectId: "project", monitorId: "monitor", fetcher, onStateChange: () => {} });
    const pending = controller.run();
    controller.dispose();
    resolveFetch!(new Response(JSON.stringify({ error: { code: "RUN_COOLDOWN", message: "secret" } }), { status: 429 }));
    await pending;
  });

  it("renders stable endpoint failures and allows a later retry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "RUN_COORDINATION_UNAVAILABLE", message: "redis://secret" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { outcome: "timeout", latencyMs: 10 } }), { status: 200 }));
    const states: Array<{ pending: boolean; result?: { outcome: string }; error?: string }> = [];
    const client = createManualRunClient({ projectId: "project", monitorId: "monitor", fetcher, onStateChange: (state) => states.push(state) });

    await client.run();
    expect(states.at(-1)).toEqual({ pending: false, error: "Manual runs are temporarily unavailable." });
    expect(JSON.stringify(states.at(-1))).not.toContain("secret");

    await client.run();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toMatchObject({ pending: false, result: { outcome: "timeout" } });
  });

  it("reports a network failure without retaining an internal exception", async () => {
    const states: Array<{ pending: boolean; error?: string }> = [];
    const client = createManualRunClient({
      projectId: "project",
      monitorId: "monitor",
      fetcher: vi.fn(async () => { throw new Error("https://secret.test/?token=bad"); }),
      onStateChange: (state) => states.push(state),
    });

    await client.run();
    expect(states.at(-1)).toEqual({ pending: false, error: "The monitor service could not be reached." });
    expect(JSON.stringify(states.at(-1))).not.toMatch(/secret|token/);
  });
});

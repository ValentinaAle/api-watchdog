import { describe, expect, it } from "vitest";
import { projectMonitorEditPath, projectMonitorPath, projectMonitorsPath } from "../../apps/web/lib/projects/paths";
import { normalizeProjectId } from "../../apps/web/lib/projects/project-id";
import { formatInterval, monitorActionApiPath, monitorApiPath } from "../../apps/web/components/monitors/types";

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

  it("normalizes the route value once and preserves malformed percent sequences safely", () => {
    expect(normalizeProjectId("Alpha")).toBe("Alpha");
    expect(normalizeProjectId("Alpha%20%26%20Beta")).toBe("Alpha & Beta");
    expect(normalizeProjectId("Alpha%2FBeta")).toBe("Alpha/Beta");
    expect(normalizeProjectId("Alpha%20%26%20Beta%2F2026")).toBe("Alpha & Beta/2026");
    expect(normalizeProjectId("Alpha%20100%25")).toBe("Alpha 100%");
    expect(normalizeProjectId("Alpha%ZZ")).toBe("Alpha%ZZ");
    expect(projectMonitorsPath(normalizeProjectId("Alpha%20%26%20Beta%2F2026")))
      .toBe("/projects/Alpha%20%26%20Beta%2F2026/monitors");
    expect(projectMonitorsPath(normalizeProjectId("Alpha%ZZ")))
      .toBe("/projects/Alpha%25ZZ/monitors");
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
});

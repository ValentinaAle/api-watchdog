import { describe, expect, it } from "vitest";
import { formatInterval, monitorActionApiPath, monitorApiPath, projectMonitorsPath } from "../../apps/web/components/monitors/types";

describe("monitor UI route and display helpers", () => {
  it("keeps every route explicitly scoped to the supplied project ID", () => {
    expect(projectMonitorsPath("c123")).toBe("/projects/c123/monitors");
    expect(monitorApiPath("c123")).toBe("/api/projects/c123/monitors");
    expect(monitorApiPath("c123", "m/1")).toBe("/api/projects/c123/monitors/m%2F1");
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

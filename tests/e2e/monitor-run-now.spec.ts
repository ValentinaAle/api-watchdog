import { expect, test, type Page } from "@playwright/test";

const projectId = "project-one";
const monitorId = "monitor-one";
const monitor = (status: "active" | "paused") => ({
  id: monitorId,
  projectId,
  name: "API health",
  url: "https://monitor.test/health",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 1_000,
  expectedStatus: 200,
  status,
  createdAt: "2026-11-23T00:00:00.000Z",
  updatedAt: "2026-11-23T00:00:00.000Z",
});

async function arrangeMonitor(page: Page, status: "active" | "paused", onRun: () => Promise<{ status: number; body: unknown }>) {
  const monitorPath = `/api/projects/${projectId}/monitors/${monitorId}`;
  const runPath = `${monitorPath}/run`;
  await page.route((url) => url.pathname === monitorPath || url.pathname === runPath, async (route) => {
    if (route.request().url().endsWith(monitorPath) && route.request().method() === "GET") {
      await route.fulfill({ json: { data: monitor(status) } });
      return;
    }
    if (route.request().url().endsWith(runPath) && route.request().method() === "POST") {
      const response = await onRun();
      await route.fulfill({ status: response.status, json: response.body });
      return;
    }
    await route.abort();
  });
}

for (const status of ["active", "paused"] as const) {
  test(`shows Run Now for a ${status} monitor and renders its transient result`, async ({ page }) => {
    let runRequests = 0;
    await arrangeMonitor(page, status, async () => {
      runRequests += 1;
      return { status: 200, body: { data: { outcome: "success", latencyMs: 12, statusCode: 200 } } };
    });

    await page.goto(`/projects/${projectId}/monitors/${monitorId}`);
    const runButton = page.getByRole("button", { name: "Run Now" });
    await expect(runButton).toBeVisible();
    if (status === "paused") {
      await runButton.focus();
      await expect(runButton).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await runButton.click();
    }
    await expect(page.getByRole("status")).toContainText("Check succeeded.");
    await expect(page.getByRole("status")).toContainText("12 ms · HTTP 200");
    expect(runRequests).toBe(1);
  });
}

test("prevents a duplicate click while pending and separates typed and endpoint failures", async ({ page }) => {
  let releaseRun: (() => void) | undefined;
  let runRequests = 0;
  await arrangeMonitor(page, "active", async () => {
    runRequests += 1;
    await new Promise<void>((resolve) => { releaseRun = resolve; });
    return { status: 200, body: { data: { outcome: "unexpected_status", latencyMs: 6, statusCode: 503 } } };
  });

  await page.goto(`/projects/${projectId}/monitors/${monitorId}`);
  await page.getByRole("button", { name: "Run Now" }).click();
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  await page.getByRole("button", { name: "Running…" }).click({ force: true });
  expect(runRequests).toBe(1);
  releaseRun!();
  await expect(page.getByRole("status")).toContainText("did not match the monitor expectation");
});

for (const [code, status, text] of [
  ["RUN_IN_PROGRESS", 409, "already in progress"],
  ["RUN_COOLDOWN", 429, "cooling down"],
  ["PROJECT_CONCURRENCY_LIMIT", 429, "capacity"],
  ["RUN_COORDINATION_UNAVAILABLE", 503, "temporarily unavailable"],
  ["INTERNAL_ERROR", 500, "could not be completed"],
] as const) {
  test(`renders ${code} as a stable endpoint error without server detail`, async ({ page }) => {
    await arrangeMonitor(page, "active", async () => ({ status, body: { error: { code, message: "redis://secret" } } }));
    await page.goto(`/projects/${projectId}/monitors/${monitorId}`);
    await page.getByRole("button", { name: "Run Now" }).click();
    const error = page.locator("#run-now-status [role=alert]");
    await expect(error).toContainText(text);
    await expect(error).not.toContainText("secret");
  });
}

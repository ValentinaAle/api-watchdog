import { expect, test, type Page } from "@playwright/test";

const monitor = {
  id: "monitor-1",
  projectId: "Alpha",
  name: "API Demo - Health Check",
  url: "https://example.com/",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 5000,
  expectedStatus: 200,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function mockMonitorApi(page: Page) {
  await page.route("**/api/projects/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/monitors")) {
      await route.fulfill({ json: { data: [monitor] } });
      return;
    }

    await route.fulfill({ json: { data: monitor } });
  });
}

test("keeps shared chrome and project context across monitor routes", async ({ page }) => {
  await mockMonitorApi(page);

  await page.goto("/projects/Alpha");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();

  await page.getByRole("link", { name: "Monitors" }).click();
  await expect(page).toHaveURL("/projects/Alpha/monitors");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();

  await page.getByRole("link", { name: /Create monitor/i }).click();
  await expect(page).toHaveURL("/projects/Alpha/monitors/new");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();

  await page.goto("/projects/Alpha/monitors/monitor-1");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL("/projects/Alpha/monitors/monitor-1/edit");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});

for (const projectId of ["Alpha", "Alpha & Beta", "Alpha/Beta", "Alpha & Beta/2026", "Alpha 100%"]) {
  test(`normalizes and encodes ${projectId} once in project-scoped monitor links`, async ({ page }) => {
    const encodedProjectId = encodeURIComponent(projectId);
    await mockMonitorApi(page);

    await page.goto(`/projects/${encodedProjectId}/monitors`);

    await expect(page.getByRole("link", { name: "Dashboard" }))
      .toHaveAttribute("href", `/projects/${encodedProjectId}`);
    await expect(page.getByRole("link", { name: "Monitors" }))
      .toHaveAttribute("href", `/projects/${encodedProjectId}/monitors`);
    await expect(page.getByRole("link", { name: /Create monitor/i }))
      .toHaveAttribute("href", `/projects/${encodedProjectId}/monitors/new`);
  });
}

test("rejects an invalid percent-encoded monitor route safely", async ({ page }) => {
  const response = await page.goto("/projects/Alpha%ZZ/monitors");

  expect(response?.status()).toBe(400);
  await expect(page.getByRole("heading", { name: "400" })).toBeVisible();
});

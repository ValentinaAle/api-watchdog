import { expect, test } from "@playwright/test";

for (const projectId of ["Alpha", "Beta"]) {
  test(`project dashboard keeps ${projectId} context without operational claims`, async ({ page }) => {
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) {
        apiRequests.push(request.url());
      }
    });

    await page.goto(`/projects/${projectId}`);

    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await expect(page.getByText(`Project ID: ${projectId}`)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", `/projects/${projectId}`);
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Monitores" })).toHaveAttribute("href", `/projects/${projectId}/monitors`);

    await expect(page.getByRole("status")).toContainText("Dashboard monitoring data is unavailable");
    await expect(page.getByRole("heading", { name: "Check status" }).locator(".."))
      .toContainText("Unavailable");
    await expect(page.getByRole("heading", { name: "Incidents" }).locator(".."))
      .toContainText("Unavailable");
    await expect(page.getByRole("heading", { name: "Monitor status" }).locator(".."))
      .toContainText("No monitor status data is available.");
    await expect(page.getByRole("heading", { name: "Activity" }).locator(".."))
      .toContainText("No activity data is available.");
    await expect(page.getByText(/100%|zero incidents|system healthy|uptime/i)).toHaveCount(0);
    expect(apiRequests).toEqual([]);
  });
}

for (const projectId of ["Alpha & Beta", "Alpha/Beta", "Alpha & Beta/2026", "Alpha 100%"]) {
test(`encodes ${projectId} once for both dashboard destinations`, async ({ page }) => {
  const encodedProjectId = encodeURIComponent(projectId);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto(`/projects/${encodedProjectId}`);

  await expect(page.getByText(`Project ID: ${projectId}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" }))
    .toHaveAttribute("href", `/projects/${encodedProjectId}`);
  await expect(page.getByRole("link", { name: "Monitores" }))
    .toHaveAttribute("href", `/projects/${encodedProjectId}/monitors`);
  expect(apiRequests).toEqual([]);
});
}

test("rejects an invalid percent-encoded project segment safely", async ({ page }) => {
  const response = await page.goto("/projects/Alpha%ZZ");

  expect(response?.status()).toBe(400);
  await expect(page.getByRole("heading", { name: "400" })).toBeVisible();
});

for (const width of [1440, 768, 390]) {
  test(`project dashboard is readable and scope-safe at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects/Alpha");

    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByRole("link", { name: "Monitores" })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  });
}

test("project dashboard navigation remains keyboard accessible", async ({ page }) => {
  await page.goto("/projects/Alpha");
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Saltar al contenido principal" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();

  await page.goto("/projects/Alpha");
  await page.keyboard.press("Tab"); // Skip link
  await page.keyboard.press("Tab"); // Brand link
  await page.keyboard.press("Tab"); // Dashboard link
  await page.keyboard.press("Tab"); // Monitors link
  await expect(page.getByRole("link", { name: "Monitores" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Monitores" })).toHaveCSS("outline-style", "solid");
});

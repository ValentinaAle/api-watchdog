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
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", `/projects/${projectId}`);
    await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Monitors" })).toHaveAttribute("href", `/projects/${projectId}/monitors`);

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

test("encodes project identity as one path segment for both destinations", async ({ page }) => {
  const projectId = "Alpha & Beta/2026";
  const encodedProjectId = encodeURIComponent(projectId);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });

  await page.goto(`/projects/${encodedProjectId}`);

  await expect(page.getByText(`Project ID: ${projectId}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" }))
    .toHaveAttribute("href", `/projects/${encodedProjectId}`);
  await expect(page.getByRole("link", { name: "Monitors" }))
    .toHaveAttribute("href", `/projects/${encodedProjectId}/monitors`);
  expect(apiRequests).toEqual([]);
});

for (const width of [1440, 768, 390]) {
  test(`project dashboard is readable and scope-safe at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/projects/Alpha");

    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByRole("link", { name: "Monitors" })).toBeVisible();
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
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();

  await page.goto("/projects/Alpha");
  await page.keyboard.press("Tab"); // Skip link
  await page.keyboard.press("Tab"); // Brand link
  await page.keyboard.press("Tab"); // Dashboard link
  await page.keyboard.press("Tab"); // Monitors link
  await expect(page.getByRole("link", { name: "Monitors" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Monitors" })).toHaveCSS("outline-style", "solid");
});

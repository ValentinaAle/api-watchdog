import { expect, test } from "@playwright/test";

test("root renders the truthful no-project shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No project context" })).toBeVisible();
  await expect(page.getByText("Requires project context")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Monitors" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Monitors" })).toHaveCount(0);
  await expect(page.locator(".app-shell__nav-unavailable")).toHaveAttribute("aria-disabled", "true");

  const projectLinks = page.locator('a[href*="/projects/"]');
  await expect(projectLinks).toHaveCount(0);
  await expect(page.getByText(/uptime|healthy|incidents|availability|telemetry/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test("shell supports keyboard skip and navigation with visible focus", async ({ page }) => {
  await page.goto("/");

  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator("main#main-content")).toBeFocused();

  await page.goto("/");
  await page.keyboard.press("Tab"); // Skip link
  await page.keyboard.press("Tab"); // Brand link
  await page.keyboard.press("Tab"); // Dashboard navigation
  const dashboardLink = page.getByRole("link", { name: "Dashboard" });
  await expect(dashboardLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "No project context" })).toBeVisible();
});

for (const width of [1440, 768, 390]) {
  test(`shell remains visible without horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No project context" })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  });
}

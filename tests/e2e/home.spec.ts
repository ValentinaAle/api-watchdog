import { expect, test } from "@playwright/test";

test("foundation page is available", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Foundation is running." })).toBeVisible();
});

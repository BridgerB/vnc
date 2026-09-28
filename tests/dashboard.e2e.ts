import { expect, test } from "@playwright/test";

test("dashboard shows the empty state on a fresh device", async ({ page }) => {
	await page.goto("/");
	await expect(page).toHaveTitle(/Relay/);
	await expect(page.getByText("Add your first machine")).toBeVisible();
});

test("quick-connect input is available", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByPlaceholder("user@host:port")).toBeVisible();
});

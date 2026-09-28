import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";

const MOCK_COLOR = [0x33, 0x66, 0xcc, 255];

const quickConnect = async (page: Page, host: string, port: number) => {
	await page.goto("/");
	await page.getByPlaceholder("user@host:port").fill(`${host}:${port}`);
	await page.getByRole("button", { name: "Quick connect" }).click();
};

const readPixel = (page: Page) =>
	page.locator("canvas").evaluate((el) => {
		const ctx = (el as HTMLCanvasElement).getContext("2d");
		if (!ctx) return null;
		const d = ctx.getImageData(0, 0, 1, 1).data;
		return [d[0], d[1], d[2], d[3]];
	});

test("connects through the bridge and paints a real frame", async ({
	page,
	vnc,
}) => {
	await quickConnect(page, vnc.host, vnc.port);
	await expect(page.locator("canvas")).toBeVisible({ timeout: 15000 });
	// A painted pixel proves the whole path: handshake -> Raw decode -> canvas.
	// The colour is only known for the mock server.
	if (vnc.mock) {
		await expect
			.poll(() => readPixel(page), { timeout: 15000 })
			.toEqual(MOCK_COLOR);
	}
});

test("shows the connected session chrome", async ({ page, vnc }) => {
	await quickConnect(page, vnc.host, vnc.port);
	await expect(page.locator("canvas")).toBeVisible({ timeout: 15000 });
	await expect(page.getByText(`${vnc.host}:${vnc.port}`)).toBeVisible();
	await expect(page.getByText("Connecting", { exact: false })).toHaveCount(0);
});

test("round-trips pointer and keyboard input to the server", async ({
	page,
	vnc,
}) => {
	test.skip(!vnc.mock, "input assertions require the in-process mock server");
	const mock = vnc.mock;
	if (!mock) return;
	await quickConnect(page, vnc.host, vnc.port);
	const canvas = page.locator("canvas");
	await expect(canvas).toBeVisible({ timeout: 15000 });

	await canvas.click({ position: { x: 8, y: 8 } });
	await page.keyboard.press("a");

	await expect.poll(() => mock.received.pointers.length).toBeGreaterThan(0);
	await expect.poll(() => mock.received.keys.length).toBeGreaterThan(0);
	// 'a' maps to X11 keysym 0x61 (keysym.ts).
	expect(mock.received.keys.some((k) => k.keysym === 0x61 && k.down)).toBe(
		true,
	);
});

test("disconnects back to the dashboard", async ({ page, vnc }) => {
	await quickConnect(page, vnc.host, vnc.port);
	await expect(page.locator("canvas")).toBeVisible({ timeout: 15000 });
	await page.mouse.move(400, 300); // reveal the auto-hiding toolbar
	await page.getByRole("button", { name: "Disconnect" }).click();
	await expect(page.getByPlaceholder("user@host:port")).toBeVisible();
});

test("surfaces an error state for an unreachable server", async ({ page }) => {
	await quickConnect(page, "127.0.0.1", 1); // nothing listens on port 1
	// autoReconnect is on by default, so a refused connection lands in the
	// reconnecting overlay.
	await expect(page.getByText("Link dropped — retrying")).toBeVisible({
		timeout: 15000,
	});
});

// Drive the vnc client for the benchmark: launch a headful Chromium on the
// harness-provided DISPLAY (so its canvas renders onto a capturable X display),
// connect to the VNC server through vnc, then hold until killed. Prints READY
// once the canvas is visible so the harness can time first-frame.

import { chromium } from "playwright";

const PREVIEW = process.env.VNC_PREVIEW_URL ?? "http://localhost:4734";
const TARGET = process.env.VNC_TARGET ?? "127.0.0.1:5900";

const t0 = Date.now();
const step = (m) =>
	console.error(`[vnc-drive] ${m} +${((Date.now() - t0) / 1000).toFixed(1)}s`);

const browser = await chromium.launch({
	headless: false,
	args: [
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		// Keep the renderer running full-speed — headless/kiosk on a GPU-less
		// runner otherwise throttles or backgrounds it and the session stalls.
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--kiosk",
		"--window-position=0,0",
		"--window-size=1280,720",
	],
});
step("browser launched");
const page = await browser.newPage({ viewport: null });

// Enable the stats HUD before the app loads.
await page.addInitScript(() => {
	try {
		const s = JSON.parse(localStorage.getItem("vnc.settings") || "{}");
		s.showStats = true;
		localStorage.setItem("vnc.settings", JSON.stringify(s));
	} catch {}
});

await page.goto(PREVIEW);
step("goto preview");
await page.getByPlaceholder("user@host:port").fill(TARGET);
await page.getByRole("button", { name: "Quick connect" }).click();
step("submitted quick-connect");
await page.locator("canvas").waitFor({ state: "visible", timeout: 60000 });
step("canvas visible");
console.log("READY");

const shutdown = async () => {
	await browser.close().catch(() => {});
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Hold the session open until the harness kills the process group.
await new Promise(() => {});

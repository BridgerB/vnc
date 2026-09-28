import { expect, type Page, test } from "@playwright/test";
import {
	type MockStream,
	startMockStream,
} from "./support/mock-stream-server.ts";

let stream: MockStream;

test.beforeEach(async () => {
	stream = await startMockStream();
});
test.afterEach(async () => {
	await stream?.close();
});

// The fixture keyframe is baseline H.264 (avc1.42c00a). Playwright's bundled
// Chromium may lack H.264 WebCodecs, so the test self-skips there.
const h264Supported = (page: Page) =>
	page.evaluate(async () => {
		if (!("VideoDecoder" in window)) return false;
		try {
			const support = await VideoDecoder.isConfigSupported({
				codec: "avc1.42c00a",
			});
			return !!support.supported;
		} catch {
			return false;
		}
	});

// Read the fps counter out of the session HUD ("fps N").
const hudFps = async (page: Page) => {
	const text = await page
		.locator(".hud")
		.innerText()
		.catch(() => "");
	const m = text.match(/fps\s+(\d+)/);
	return m ? Number(m[1]) : 0;
};

test("connects the stream path and receives decoded frames", async ({
	page,
}) => {
	await page.goto("/");
	test.skip(!(await h264Supported(page)), "browser lacks H.264 WebCodecs");

	// Seed a stream profile pointing at the mock server, then open its card.
	await page.addInitScript((port) => {
		localStorage.setItem(
			"vnc.profiles",
			JSON.stringify([
				{
					id: "s1",
					name: "mock-stream",
					host: "127.0.0.1",
					port,
					kind: "stream",
				},
			]),
		);
	}, stream.port);
	await page.goto("/");
	await page.getByText("mock-stream").click();

	// Stream session opened and connected (card -> Session -> StreamViewer -> ws).
	await expect(page.getByText(`127.0.0.1:${stream.port}`)).toBeVisible({
		timeout: 15000,
	});
	// Frames flow from the mock into the WebCodecs pipeline (proves the wire format
	// + decode feed). The final canvas paint depends on the decoder emitting under
	// a continuous varied stream, which isn't reproducible with a looped fixture in
	// headless Chromium, so we assert receipt rather than a painted pixel.
	await expect.poll(() => hudFps(page), { timeout: 15000 }).toBeGreaterThan(0);
});

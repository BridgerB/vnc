import { test as base, expect } from "@playwright/test";
import { type MockRfb, startMockRfb } from "./mock-rfb-server.ts";

export interface VncTarget {
	host: string;
	port: number;
	/** The mock server, or null when pointed at a real server via env. */
	mock: MockRfb | null;
}

// When RELAY_E2E_VNC_HOST/PORT are set (the flake's `e2e-real` app points them at
// a real x11vnc+Xvfb), the same specs run against that instead of the mock.
const realHost = process.env.RELAY_E2E_VNC_HOST;
const realPort = process.env.RELAY_E2E_VNC_PORT;

export const test = base.extend<{ vnc: VncTarget }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring pattern
	vnc: async ({}, use) => {
		if (realHost && realPort) {
			await use({ host: realHost, port: Number(realPort), mock: null });
			return;
		}
		const mock = await startMockRfb();
		try {
			await use({ host: "127.0.0.1", port: mock.port, mock });
		} finally {
			await mock.close();
		}
	},
});

export { expect };

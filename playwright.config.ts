import { portFromName } from "@bridgerb/port-from-name";
import { defineConfig } from "@playwright/test";

// autoPort() in vite.config.ts derives the dev/preview port from the project
// name, so preview isn't on Vite's default 4173. Ask the package for the same
// number rather than hardcoding it, so this stays in sync with the name/range.
export default defineConfig({
	webServer: {
		command: "npm run build && npm run preview",
		port: portFromName(),
		reuseExistingServer: !process.env.CI,
	},
	testMatch: "**/*.e2e.{ts,js}",
});

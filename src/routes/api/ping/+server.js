import net from "node:net";
import { error, json } from "@sveltejs/kit";
import { isAllowedHost, isValidPort } from "$lib/server/vnc/net-allow.js";

/**
 * Quick TCP reachability probe used by the dashboard to show online/offline.
 * GET /api/ping?host=127.0.0.1&port=5900 -> { open, ms }
 */
export async function GET({ url }) {
	const host = url.searchParams.get("host") || "";
	const port = parseInt(url.searchParams.get("port") || "5900", 10);
	if (!isAllowedHost(host)) throw error(400, "host not allowed");
	if (!isValidPort(port)) throw error(400, "invalid port");

	const start = Date.now();
	const open = await new Promise((resolve) => {
		const socket = new net.Socket();
		let done = false;
		const finish = (/** @type {boolean} */ ok) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(1500);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, host);
	});
	return json({ open, ms: Date.now() - start });
}

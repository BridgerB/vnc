import net from "node:net";
import { error, json } from "@sveltejs/kit";
import { isAllowedHost, isValidPort } from "$lib/server/vnc/net-allow.ts";
import type { RequestHandler } from "./$types";

const PROBE_TIMEOUT_MS = 1500;

/**
 * Quick TCP reachability probe used by the dashboard to show online/offline.
 * GET /api/ping?host=127.0.0.1&port=5900 -> { open, ms }
 */
export const GET: RequestHandler = async ({ url }) => {
	const host = url.searchParams.get("host") ?? "";
	const port = Number.parseInt(url.searchParams.get("port") ?? "5900", 10);
	if (!isAllowedHost(host)) throw error(400, "host not allowed");
	if (!isValidPort(port)) throw error(400, "invalid port");

	const start = Date.now();
	const open = await probe(host, port);
	return json({ open, ms: Date.now() - start });
};

/** Resolve true if a TCP connection opens within the timeout, false otherwise. */
const probe = (host: string, port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = new net.Socket();
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, host);
	});

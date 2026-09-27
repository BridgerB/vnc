import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import { bridge } from "./bridge.ts";
import { isAllowedHost, isValidPort } from "./net-allow.ts";

// Vite's dev/preview HTTP server (http.Server, or an Http2SecureServer).
type HttpServer = NonNullable<ViteDevServer["httpServer"]>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5900;

// Servers already wired, so a re-run of configureServer doesn't double-attach.
const attached = new WeakSet<HttpServer>();

/**
 * Attach a WebSocket VNC bridge at the `/vnc` path on the HTTP server Vite
 * already runs. The browser connects to
 * `ws://<host>/vnc?host=127.0.0.1&port=5900[&password=...]` and the bridge opens
 * a TCP connection to that VNC server. Only loopback / private targets are
 * allowed, so the dev server can't be turned into an open TCP proxy.
 */
const attach = (server: HttpServer) => {
	if (attached.has(server)) return;
	attached.add(server);
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://localhost");
		} catch {
			return;
		}
		if (url.pathname !== "/vnc") return; // let Vite's own HMR upgrades pass

		const host = url.searchParams.get("host") || DEFAULT_HOST;
		const port = Number.parseInt(
			url.searchParams.get("port") ?? String(DEFAULT_PORT),
			10,
		);
		const password = url.searchParams.get("password") ?? "";

		if (!isAllowedHost(host) || !isValidPort(port)) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) =>
			bridge(ws, { host, port, password }),
		);
	});
	console.log("[vnc] bridge listening on ws path /vnc");
};

/**
 * This module is loaded once at server start and is NOT hot-reloaded — restart
 * the dev server after editing anything under src/lib/server/vnc/.
 */
export const vncBridgePlugin = (): Plugin => ({
	name: "vnc-bridge",
	configureServer(server) {
		const s = server.httpServer;
		if (s) attach(s);
		else
			server.httpServer?.once?.("listening", () => {
				if (server.httpServer) attach(server.httpServer);
			});
	},
	configurePreviewServer(server) {
		if (server.httpServer) attach(server.httpServer);
	},
});

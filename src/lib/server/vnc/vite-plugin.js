import { WebSocketServer } from "ws";
import { bridge } from "./bridge.js";
import { isAllowedHost, isValidPort } from "./net-allow.js";

/**
 * Vite plugin that attaches a WebSocket VNC bridge at the `/vnc` path on the
 * same HTTP server Vite already runs (dev and preview). The browser connects to
 * `ws://<host>/vnc?host=127.0.0.1&port=5900[&password=...]` and the bridge opens
 * a TCP connection to that VNC server.
 *
 * Only loopback / private targets are allowed by default to avoid turning the
 * dev server into an open TCP proxy.
 */
export function vncBridgePlugin() {
	/** @param {any} server an http.Server (dev) or preview server's httpServer */
	const attach = (server) => {
		if (!server || server.__vncBridgeAttached) return;
		server.__vncBridgeAttached = true;
		const wss = new WebSocketServer({ noServer: true });

		server.on(
			"upgrade",
			/**
			 * @param {import('http').IncomingMessage} req
			 * @param {import('stream').Duplex} socket
			 * @param {Buffer} head
			 */
			(req, socket, head) => {
				let url;
				try {
					url = new URL(req.url || "/", "http://localhost");
				} catch {
					return;
				}
				if (url.pathname !== "/vnc") return; // let Vite's own HMR upgrades pass

				const host = url.searchParams.get("host") || "127.0.0.1";
				const port = parseInt(url.searchParams.get("port") || "5900", 10);
				const password = url.searchParams.get("password") || "";

				if (!isAllowedHost(host) || !isValidPort(port)) {
					socket.destroy();
					return;
				}

				wss.handleUpgrade(req, socket, head, (ws) => {
					bridge(ws, { host, port, password });
				});
			},
		);
		// eslint-disable-next-line no-console
		console.log("[vnc] bridge listening on ws path /vnc");
	};

	return {
		name: "vnc-bridge",
		/** @param {any} server */
		configureServer(server) {
			// Defer until the httpServer exists.
			const s = server.httpServer;
			if (s) attach(s);
			else
				server.httpServer?.once?.("listening", () => attach(server.httpServer));
		},
		/** @param {any} server */
		configurePreviewServer(server) {
			attach(server.httpServer);
		},
	};
}

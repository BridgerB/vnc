import { RfbClient } from "./rfb-client.js";

/**
 * Bridge a single browser WebSocket to a VNC server via an RfbClient.
 *
 * Wire protocol to the browser:
 *   - JSON text frames for control:
 *       { type: 'init',   width, height, name }
 *       { type: 'resize', width, height }
 *       { type: 'bell' }
 *       { type: 'cuttext', text }
 *       { type: 'error',  message }
 *   - Binary frames for pixels:
 *       tag=1 RAW:   u8 tag, u16 x, u16 y, u16 w, u16 h, then w*h*4 RGBA bytes
 *       tag=2 COPY:  u8 tag, u16 x, u16 y, u16 w, u16 h, u16 srcX, u16 srcY
 *
 * Wire protocol from the browser (JSON text frames):
 *       { type: 'pointer', x, y, buttons }
 *       { type: 'key',     keysym, down }
 *       { type: 'cuttext', text }
 *       { type: 'refresh' }         // force a full non-incremental update
 *
 * @param {import('ws').WebSocket} ws
 * @param {{ host?: string, port?: number, password?: string }} opts
 */
export function bridge(ws, opts = {}) {
	const rfb = new RfbClient(opts);

	/** @param {any} obj */
	const sendJson = (obj) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
	};

	rfb.on("init", ({ width, height, name }) => {
		sendJson({ type: "init", width, height, name });
	});

	// The initial pull must be non-incremental until we've actually received
	// pixel data. WayVNC answers the first full request with an ExtDesktopSize-
	// only update (no pixels); an incremental request after that would only ever
	// return changes, so the screen would stay blank. Keep asking for the full
	// framebuffer until a real rectangle arrives, and again after any resize.
	let gotFrame = false;
	// When the server supports Continuous Updates it pushes changes on its own, so
	// we stop sending a FramebufferUpdateRequest per frame — that removes one
	// round-trip of latency per frame over the link.
	let continuous = false;
	rfb.on("continuousupdates", () => {
		continuous = true;
	});

	rfb.on("resize", ({ width, height }) => {
		gotFrame = false;
		sendJson({ type: "resize", width, height });
	});

	rfb.on("rect", (r) => {
		gotFrame = true;
		if (ws.readyState !== ws.OPEN) return;
		if (r.copy) {
			const b = Buffer.alloc(13);
			b[0] = 2;
			b.writeUInt16BE(r.x, 1);
			b.writeUInt16BE(r.y, 3);
			b.writeUInt16BE(r.width, 5);
			b.writeUInt16BE(r.height, 7);
			b.writeUInt16BE(r.copy.srcX, 9);
			b.writeUInt16BE(r.copy.srcY, 11);
			ws.send(b);
		} else {
			const head = Buffer.alloc(9);
			head[0] = 1;
			head.writeUInt16BE(r.x, 1);
			head.writeUInt16BE(r.y, 3);
			head.writeUInt16BE(r.width, 5);
			head.writeUInt16BE(r.height, 7);
			ws.send(Buffer.concat([head, r.data]));
		}
	});

	// Continuous pull loop: after each completed update, ask for the next
	// incremental one. The server only replies when something changes, so this
	// does not busy-loop.
	rfb.on("updateDone", () => {
		sendJson({ type: "frame" }); // one real framebuffer update completed
		// Keep pulling until the first real frame arrives; after that, only pull if
		// the server is NOT streaming continuous updates on its own.
		if (!gotFrame) rfb.requestUpdate(false);
		else if (!continuous) rfb.requestUpdate(true);
	});

	rfb.on("bell", () => sendJson({ type: "bell" }));
	rfb.on("cuttext", (text) => sendJson({ type: "cuttext", text }));

	rfb.on("cursor", (c) => {
		if (ws.readyState !== ws.OPEN) return;
		const head = Buffer.alloc(9);
		head[0] = 3; // cursor tag
		head.writeUInt16BE(c.width, 1);
		head.writeUInt16BE(c.height, 3);
		head.writeUInt16BE(c.hotspotX, 5);
		head.writeUInt16BE(c.hotspotY, 7);
		ws.send(c.data.length ? Buffer.concat([head, c.data]) : head);
	});

	rfb.on("error", (e) => {
		sendJson({ type: "error", message: e.message });
		try {
			ws.close();
		} catch {
			/* ignore */
		}
	});
	rfb.on("close", () => {
		try {
			ws.close();
		} catch {
			/* ignore */
		}
	});

	ws.on("message", (data, isBinary) => {
		if (isBinary) return; // browser -> server is JSON only
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		switch (msg.type) {
			case "pointer":
				rfb.pointerEvent(msg.x, msg.y, msg.buttons);
				break;
			case "key":
				rfb.keyEvent(msg.keysym, msg.down);
				break;
			case "cuttext":
				rfb.cutText(String(msg.text ?? ""));
				break;
			case "refresh":
				rfb.requestUpdate(false);
				break;
		}
	});

	ws.on("close", () => rfb.close());
	ws.on("error", () => rfb.close());

	rfb.connect();
}

import type { RawData, WebSocket } from "ws";
import { RfbClient, type RfbOptions } from "./rfb-client.ts";

/**
 * Bridge a single browser WebSocket to a VNC server via an RfbClient.
 *
 * To the browser: JSON text frames for control (init/resize/frame/bell/cuttext/
 * error) and binary frames for pixels — tag 1 raw RGBA rect, tag 2 CopyRect,
 * tag 3 cursor. From the browser: JSON pointer/key/cuttext/refresh.
 */

/** Control frames sent to the browser. */
type ControlMsg =
	| { type: "init"; width: number; height: number; name: string }
	| { type: "resize"; width: number; height: number }
	| { type: "frame" }
	| { type: "bell" }
	| { type: "cuttext"; text: string }
	| { type: "error"; message: string };

const TAG_RAW = 1;
const TAG_COPYRECT = 2;
const TAG_CURSOR = 3;

export const bridge = (ws: WebSocket, opts: RfbOptions = {}) => {
	const rfb = new RfbClient(opts);

	const sendJson = (msg: ControlMsg) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
	};
	const isOpen = () => ws.readyState === ws.OPEN;

	rfb.on("init", ({ width, height, name }) =>
		sendJson({ type: "init", width, height, name }),
	);

	// The initial pull must be non-incremental until we've actually received pixel
	// data. WayVNC answers the first full request with an ExtDesktopSize-only
	// update (no pixels); an incremental request after that would only ever return
	// changes, so the screen would stay blank. Keep asking for the full framebuffer
	// until a real rectangle arrives, and again after any resize.
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
		if (!isOpen()) return;
		if ("copy" in r) {
			const b = Buffer.alloc(13);
			b[0] = TAG_COPYRECT;
			b.writeUInt16BE(r.x, 1);
			b.writeUInt16BE(r.y, 3);
			b.writeUInt16BE(r.width, 5);
			b.writeUInt16BE(r.height, 7);
			b.writeUInt16BE(r.copy.srcX, 9);
			b.writeUInt16BE(r.copy.srcY, 11);
			ws.send(b);
		} else {
			const head = Buffer.alloc(9);
			head[0] = TAG_RAW;
			head.writeUInt16BE(r.x, 1);
			head.writeUInt16BE(r.y, 3);
			head.writeUInt16BE(r.width, 5);
			head.writeUInt16BE(r.height, 7);
			ws.send(Buffer.concat([head, r.data]));
		}
	});

	// Continuous pull loop: after each completed update, ask for the next
	// incremental one. The server only replies when something changes, so this
	// doesn't busy-loop.
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
		if (!isOpen()) return;
		const head = Buffer.alloc(9);
		head[0] = TAG_CURSOR;
		head.writeUInt16BE(c.width, 1);
		head.writeUInt16BE(c.height, 3);
		head.writeUInt16BE(c.hotspotX, 5);
		head.writeUInt16BE(c.hotspotY, 7);
		ws.send(c.data.length ? Buffer.concat([head, c.data]) : head);
	});

	const closeWs = () => {
		try {
			ws.close();
		} catch {
			/* ignore */
		}
	};
	rfb.on("error", (e) => {
		sendJson({ type: "error", message: e.message });
		closeWs();
	});
	rfb.on("close", closeWs);

	ws.on("message", (data: RawData, isBinary: boolean) => {
		if (isBinary) return; // browser -> server is JSON only
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		switch (msg.type) {
			case "pointer":
				rfb.pointerEvent(Number(msg.x), Number(msg.y), Number(msg.buttons));
				break;
			case "key":
				rfb.keyEvent(Number(msg.keysym), Boolean(msg.down));
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
};

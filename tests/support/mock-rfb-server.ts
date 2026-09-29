import net from "node:net";

/**
 * A minimal mock RFB (VNC) server for e2e tests. It performs just enough of the
 * protocol for the real RfbClient (src/lib/server/vnc/rfb-client.ts) to complete
 * the handshake, receive one Raw framebuffer rect (a known solid colour), and
 * have its pointer/key events recorded — so a Playwright test can drive the full
 * browser -> bridge -> RFB -> canvas pipeline against a real socket.
 *
 * Security None only (quick-connect sends no password). Big-endian on the wire.
 */

export interface Pointer {
	x: number;
	y: number;
	buttons: number;
}
export interface Key {
	keysym: number;
	down: boolean;
}
export interface MockRfb {
	port: number;
	received: { pointers: Pointer[]; keys: Key[] };
	close: () => Promise<void>;
}

export interface MockRfbOptions {
	width?: number;
	height?: number;
	/** Framebuffer fill colour as [r, g, b] (the pattern the test asserts). */
	color?: [number, number, number];
	name?: string;
}

// Client -> server message types we consume, with their fixed byte lengths.
const MSG_SET_PIXEL_FORMAT = 0;
const MSG_SET_ENCODINGS = 2;
const MSG_FB_UPDATE_REQUEST = 3;
const MSG_KEY_EVENT = 4;
const MSG_POINTER_EVENT = 5;
const MSG_CLIENT_CUT_TEXT = 6;
const MSG_ENABLE_CONTINUOUS_UPDATES = 150;
const MSG_CLIENT_FENCE = 248;

export const startMockRfb = (opts: MockRfbOptions = {}): Promise<MockRfb> => {
	const width = opts.width ?? 64;
	const height = opts.height ?? 48;
	const [r, g, b] = opts.color ?? [0x33, 0x66, 0xcc];
	const name = opts.name ?? "vnc-mock";
	const received: MockRfb["received"] = { pointers: [], keys: [] };

	const serverInit = () => {
		const nameBuf = Buffer.from(name, "latin1");
		const head = Buffer.alloc(24);
		head.writeUInt16BE(width, 0);
		head.writeUInt16BE(height, 2);
		// bytes 4..19 = server pixel format (ignored by the client); leave zero.
		head.writeUInt32BE(nameBuf.length, 20);
		return Buffer.concat([head, nameBuf]);
	};

	const framebufferUpdate = () => {
		const header = Buffer.alloc(4);
		header[0] = 0; // FramebufferUpdate
		header.writeUInt16BE(1, 2); // one rect
		const rect = Buffer.alloc(12);
		rect.writeUInt16BE(0, 0); // x
		rect.writeUInt16BE(0, 2); // y
		rect.writeUInt16BE(width, 4);
		rect.writeUInt16BE(height, 6);
		rect.writeInt32BE(0, 8); // encoding: Raw
		const pixels = Buffer.alloc(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			pixels[i * 4] = r;
			pixels[i * 4 + 1] = g;
			pixels[i * 4 + 2] = b;
			pixels[i * 4 + 3] = 0; // X byte (alpha forced to 255 client-side)
		}
		return Buffer.concat([header, rect, pixels]);
	};

	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let phase: "version" | "security" | "clientinit" | "messages" = "version";
		let buf: Buffer = Buffer.alloc(0);
		let sentFrame = false;

		socket.write(Buffer.from("RFB 003.008\n", "latin1"));

		const need = (n: number) => buf.length >= n;
		const take = (n: number) => {
			const out = buf.subarray(0, n);
			buf = buf.subarray(n);
			return out;
		};

		// Consume one complete client->server message; return false if incomplete.
		const step = (): boolean => {
			if (phase === "version") {
				if (!need(12)) return false;
				take(12);
				socket.write(Buffer.from([1, 1])); // count=1, type=1 (None)
				phase = "security";
				return true;
			}
			if (phase === "security") {
				if (!need(1)) return false;
				take(1); // chosen security type
				const ok = Buffer.alloc(4); // SecurityResult = 0
				socket.write(ok);
				phase = "clientinit";
				return true;
			}
			if (phase === "clientinit") {
				if (!need(1)) return false;
				take(1); // shared flag
				socket.write(serverInit());
				phase = "messages";
				return true;
			}
			// phase === "messages"
			if (!need(1)) return false;
			const type = buf[0];
			switch (type) {
				case MSG_SET_PIXEL_FORMAT:
					if (!need(20)) return false;
					take(20);
					return true;
				case MSG_SET_ENCODINGS: {
					if (!need(4)) return false;
					const count = buf.readUInt16BE(2);
					if (!need(4 + count * 4)) return false;
					take(4 + count * 4);
					return true;
				}
				case MSG_FB_UPDATE_REQUEST:
					if (!need(10)) return false;
					take(10);
					// Answer the first request with one frame; ignore the rest so the
					// pull loop goes quiet after the canvas has painted.
					if (!sentFrame) {
						sentFrame = true;
						socket.write(framebufferUpdate());
					}
					return true;
				case MSG_KEY_EVENT: {
					if (!need(8)) return false;
					const m = take(8);
					received.keys.push({ keysym: m.readUInt32BE(4), down: m[1] !== 0 });
					return true;
				}
				case MSG_POINTER_EVENT: {
					if (!need(6)) return false;
					const m = take(6);
					received.pointers.push({
						buttons: m[1],
						x: m.readUInt16BE(2),
						y: m.readUInt16BE(4),
					});
					return true;
				}
				case MSG_CLIENT_CUT_TEXT: {
					if (!need(8)) return false;
					const len = buf.readUInt32BE(4);
					if (!need(8 + len)) return false;
					take(8 + len);
					return true;
				}
				case MSG_ENABLE_CONTINUOUS_UPDATES:
					if (!need(10)) return false;
					take(10);
					return true;
				case MSG_CLIENT_FENCE: {
					if (!need(9)) return false;
					const len = buf[8];
					if (!need(9 + len)) return false;
					take(9 + len);
					return true;
				}
				default:
					socket.destroy();
					return false;
			}
		};

		socket.on("data", (chunk: Buffer) => {
			buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
			while (step()) {}
		});
		socket.on("error", () => socket.destroy());
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				port,
				received,
				close: () =>
					new Promise((res) => {
						// Destroy live connections (the bridge keeps one open for the whole
						// session) so server.close() can actually complete.
						for (const s of sockets) s.destroy();
						server.close(() => res());
					}),
			});
		});
	});
};

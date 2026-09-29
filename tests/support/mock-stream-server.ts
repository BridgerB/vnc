import { type WebSocket, WebSocketServer } from "ws";
import { H264_KEYFRAME_BASE64 } from "./h264-keyframe.base64.ts";

/**
 * A mock vnc stream server for e2e: on connect it sends one keyframe in the
 * wire format StreamViewer expects — [u8 keyframe][u32 ts-ms][Annex-B AU] — and
 * records inbound JSON input messages. No NVENC/ffmpeg needed.
 */
export interface MockStream {
	port: number;
	received: unknown[];
	close: () => Promise<void>;
}

export const startMockStream = (): Promise<MockStream> => {
	const keyframe = Buffer.from(H264_KEYFRAME_BASE64, "base64");
	const received: unknown[] = [];
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

	wss.on("connection", (ws: WebSocket) => {
		const send = () => {
			if (ws.readyState !== ws.OPEN) return;
			const head = Buffer.alloc(5);
			head[0] = 1; // keyframe flag
			head.writeUInt32BE(Date.now() >>> 0, 1);
			ws.send(Buffer.concat([head, keyframe]));
		};
		send();
		// Keep sending so the WebCodecs decoder actually flushes a frame out (a lone
		// keyframe can sit buffered under optimizeForLatency).
		const timer = setInterval(send, 100);
		ws.on("close", () => clearInterval(timer));
		ws.on("message", (raw, isBinary) => {
			if (isBinary) return;
			try {
				received.push(JSON.parse(raw.toString()));
			} catch {
				/* ignore */
			}
		});
	});

	return new Promise((resolve) => {
		wss.on("listening", () => {
			const addr = wss.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				port,
				received,
				close: () =>
					new Promise((res) => {
						for (const client of wss.clients) client.terminate();
						wss.close(() => res());
					}),
			});
		});
	});
};

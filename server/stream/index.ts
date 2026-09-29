/**
 * vnc stream server — runs ON the wlroots/Hyprland box (Node 23+, runs .ts natively).
 *
 * Pipeline: wf-recorder (wlr-screencopy) -> h264_nvenc -> Annex-B access units,
 * one shared encoder fanned out to every client over a plain `ws` WebSocket.
 * Browsers decode with WebCodecs.
 *
 * Transport encryption + access control is meant to be handled at the network
 * layer: bind it to a WireGuard/VPN interface (or loopback for an SSH tunnel)
 * and firewall the LAN, so there is no cleartext video on the wire and no TLS or
 * token needed in-process. Native Node only: pure-JS `ws` + built-in `http`.
 *
 * Env (all optional — sensible defaults):
 *   PORT=4735                 ws port
 *   HOST=0.0.0.0              bind address (put your VPN/loopback IP here to
 *                             avoid exposing it, e.g. HOST=10.0.0.2)
 *   OUTPUT=DP-2               wlroots output to capture (unset = default output)
 *   WAYLAND_DISPLAY=wayland-1
 *   XDG_RUNTIME_DIR=/run/user/1000
 *   BITRATE=40M  GOP=120  PRESET=p1
 *
 * Input is injected in-process via Linux uinput (see uinput.ts) — no Python.
 */

import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { createUinput, type Uinput } from "./uinput.ts";

// ---- data ----------------------------------------------------------------

/** Runtime configuration, resolved once from the environment at startup. */
type Config = {
	port: number;
	host: string;
	output: string;
	waylandDisplay: string;
	xdgRuntimeDir: string;
	bitrate: string;
	gop: string;
	preset: string;
};

/** One decoded H.264 access unit (a whole frame), ready to send. */
type Frame = { keyframe: boolean; data: Buffer };

/** Carried state of the Annex-B parser between stdout chunks. */
type NalStream = { buf: Buffer; au: Buffer[]; hasVcl: boolean };

/** Input messages from the browser, as a discriminated union on `t`. */
type InputMsg =
	| { t: "a"; x: number; y: number } // absolute pointer, x/y in 0..65535
	| { t: "m"; dx: number; dy: number } // relative move
	| { t: "btn"; b: number; down: boolean } // button b=0/1/2
	| { t: "wheel"; dy?: number; dx?: number } // dy vertical (+up), dx horizontal
	| { t: "key"; code: number; down: boolean }; // code = Linux keycode

const assertNever = (x: never): never => {
	throw new Error(`unreachable: ${JSON.stringify(x)}`);
};

// ---- pure: input parsing -------------------------------------------------

const toInt = (v: unknown) => (typeof v === "number" ? v | 0 : 0);

/** Parse untrusted JSON into an InputMsg, or null if it isn't one. */
const parseInput = (raw: unknown): InputMsg | null => {
	if (typeof raw !== "object" || raw === null) return null;
	const m = raw as Record<string, unknown>;
	switch (m.t) {
		case "a":
			return { t: "a", x: toInt(m.x), y: toInt(m.y) };
		case "m":
			return { t: "m", dx: toInt(m.dx), dy: toInt(m.dy) };
		case "btn":
			return { t: "btn", b: toInt(m.b), down: !!m.down };
		case "wheel":
			return { t: "wheel", dy: toInt(m.dy), dx: toInt(m.dx) };
		case "key":
			return { t: "key", code: toInt(m.code), down: !!m.down };
		default:
			return null;
	}
};

// ---- pure: Annex-B parsing -----------------------------------------------

const START_CODE = Buffer.from([0, 0, 0, 1]);
const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

const emptyNalStream = (): NalStream => ({
	buf: Buffer.alloc(0),
	au: [],
	hasVcl: false,
});

const nalType = (nal: Buffer) => (nal[0] ?? 0) & 0x1f;
const isVcl = (type: number) => type === NAL_SLICE || type === NAL_IDR;
// A parameter set, SEI, access-unit delimiter, or a VCL slice all begin a new AU.
const beginsAccessUnit = (type: number) =>
	isVcl(type) ||
	type === NAL_AUD ||
	type === NAL_SPS ||
	type === NAL_PPS ||
	type === NAL_SEI;

/** Byte offsets of every 3-byte start code (00 00 01) in the buffer. */
const startCodeOffsets = (buf: Buffer): number[] => {
	const offsets: number[] = [];
	for (let i = 0; i + 2 < buf.length; i++) {
		if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
			offsets.push(i);
			i += 2;
		}
	}
	return offsets;
};

/** Serialize the pending access unit into a Frame and reset the stream for the next. */
const flushAccessUnit = (stream: NalStream): Frame | null => {
	if (!stream.au.length) return null;
	let keyframe = false;
	const parts: Buffer[] = [];
	for (const nal of stream.au) {
		if (nalType(nal) === NAL_IDR) keyframe = true;
		parts.push(START_CODE, nal);
	}
	stream.au = [];
	stream.hasVcl = false;
	return { keyframe, data: Buffer.concat(parts) };
};

/**
 * Append one NAL to the pending access unit. Returns the previous AU as a Frame
 * when this NAL begins a new one — flushing as soon as the next AU starts saves
 * roughly a frame of pipeline latency versus waiting for the next VCL slice.
 */
const appendNal = (stream: NalStream, nal: Buffer): Frame | null => {
	if (!nal.length) return null;
	const type = nalType(nal);
	const frame =
		stream.hasVcl && beginsAccessUnit(type) ? flushAccessUnit(stream) : null;
	stream.au.push(nal);
	if (isVcl(type)) stream.hasVcl = true;
	return frame;
};

/**
 * Feed a chunk of the raw H.264 elementary stream; returns any complete access
 * units it produced. Mutates `stream` (the carried remainder + pending AU).
 */
const pushChunk = (stream: NalStream, chunk: Buffer): Frame[] => {
	stream.buf = stream.buf.length ? Buffer.concat([stream.buf, chunk]) : chunk;
	const offsets = startCodeOffsets(stream.buf);
	if (offsets.length < 2) return []; // need one complete NAL boundary

	const frames: Frame[] = [];
	for (let s = 0; s < offsets.length - 1; s++) {
		const start = offsets[s];
		const next = offsets[s + 1];
		if (start === undefined || next === undefined) continue;
		const nalStart = start + 3;
		let end = next;
		// Trailing 0x00 bytes are padding (trailing_zero_8bits / the leading zero
		// of a 4-byte start code), not part of the NAL body.
		while (end > nalStart && stream.buf[end - 1] === 0) end--;
		const frame = appendNal(stream, stream.buf.subarray(nalStart, end));
		if (frame) frames.push(frame);
	}
	// Keep everything from the last start code onward (an incomplete NAL).
	const last = offsets[offsets.length - 1];
	if (last !== undefined) stream.buf = stream.buf.subarray(last);
	return frames;
};

/** Frame an access unit for the wire: [u8 keyframe][u32 timestamp-ms] + Annex-B AU. */
const frameForWire = (frame: Frame, nowMs: number): Buffer => {
	const head = Buffer.alloc(5);
	head[0] = frame.keyframe ? 1 : 0;
	head.writeUInt32BE(nowMs >>> 0, 1);
	return Buffer.concat([head, frame.data]);
};

/** wf-recorder arguments for an ultra-low-latency NVENC H.264 elementary stream. */
const captureArgs = (cfg: Config): string[] => [
	...(cfg.output ? ["-o", cfg.output] : []),
	"-c",
	"h264_nvenc",
	"-m",
	"h264",
	"-x",
	"yuv420p",
	"-f",
	"pipe:1",
	"-p",
	`preset=${cfg.preset}`,
	"-p",
	"tune=ull", // ultra-low-latency NVENC tuning
	"-p",
	"rc=cbr",
	"-p",
	`b=${cfg.bitrate}`, // the codec option is `b`, not the CLI's `b:v`
	"-p",
	"bf=0", // no B-frames (no reordering latency)
	"-p",
	"delay=0", // emit each frame immediately
	"-p",
	"rc-lookahead=0", // no lookahead buffer
	"-p",
	"no-scenecut=1", // no surprise keyframes -> no latency spikes
	"-p",
	`g=${cfg.gop}`,
	// full-range BT.709 VUI so WebCodecs decodes colours correctly.
	"-p",
	"color_range=pc",
	"-p",
	"colorspace=bt709",
	"-p",
	"color_primaries=bt709",
	"-p",
	"color_trc=bt709",
];

// ---- effects -------------------------------------------------------------

const readConfig = (env: NodeJS.ProcessEnv): Config => ({
	port: Number(env.PORT ?? 4735),
	host: env.HOST ?? "0.0.0.0",
	output: env.OUTPUT ?? "", // empty -> wf-recorder picks the default output
	waylandDisplay: env.WAYLAND_DISPLAY ?? "wayland-1",
	xdgRuntimeDir: env.XDG_RUNTIME_DIR ?? "/run/user/1000",
	bitrate: env.BITRATE ?? "40M",
	gop: env.GOP ?? "120",
	preset: env.PRESET ?? "p1", // p1 = fastest encode = lowest latency
});

/** Spawn wf-recorder; raw stdout goes to `onData`, exit to `onExit`. */
const startCapture = (
	cfg: Config,
	onData: (chunk: Buffer) => void,
	onExit: (code: number | null) => void,
): ChildProcess => {
	const child = spawn("wf-recorder", captureArgs(cfg), {
		env: {
			...process.env,
			WAYLAND_DISPLAY: cfg.waylandDisplay,
			XDG_RUNTIME_DIR: cfg.xdgRuntimeDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", onData);
	child.stderr?.on("data", (d: Buffer) => {
		const text = d.toString();
		if (/error|failed|invalid/i.test(text))
			console.error("[wf-recorder]", text.trim());
	});
	child.on("exit", (code) => {
		console.log("[capture] wf-recorder exited", code);
		onExit(code);
	});
	return child;
};

/** Inject one parsed input message into the virtual device. */
const injectInput = (ui: Uinput, m: InputMsg) => {
	switch (m.t) {
		case "a":
			return ui.moveAbs(m.x, m.y);
		case "m":
			return ui.moveRel(m.dx, m.dy);
		case "btn":
			return ui.button(m.b, m.down);
		case "wheel": {
			if (m.dy) ui.wheel(m.dy);
			if (m.dx) ui.hwheel(m.dx);
			return;
		}
		case "key":
			return ui.key(m.code, m.down);
		default:
			return assertNever(m);
	}
};

/**
 * The shared capture fanned out to all clients. A consumer NVIDIA GPU caps
 * concurrent NVENC sessions and re-capturing the same screen per client wastes
 * GPU and bandwidth, so we encode once and broadcast, priming late joiners with
 * the most recent keyframe.
 */
type Broadcaster = {
	add: (ws: WebSocket) => void;
	remove: (ws: WebSocket) => void;
};

const startBroadcaster = (cfg: Config): Broadcaster => {
	const clients = new Set<WebSocket>();
	const stream = emptyNalStream();
	let capture: ChildProcess | null = null;
	let lastKeyframe: Buffer | null = null;

	const broadcast = (frame: Frame) => {
		const framed = frameForWire(frame, Date.now());
		if (frame.keyframe) lastKeyframe = framed;
		for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(framed);
	};

	const ensureCapture = () => {
		if (capture) return;
		console.log("[capture] starting shared encoder");
		capture = startCapture(
			cfg,
			(chunk) => {
				for (const frame of pushChunk(stream, chunk)) broadcast(frame);
			},
			(code) => {
				capture = null;
				lastKeyframe = null;
				if (clients.size > 0) {
					console.log("[capture] exited unexpectedly, restarting", code);
					setTimeout(ensureCapture, 500);
				}
			},
		);
	};

	const stopIfIdle = () => {
		if (clients.size > 0 || !capture) return;
		console.log("[capture] no clients; stopping encoder");
		capture.kill("SIGINT");
		capture = null;
		lastKeyframe = null;
	};

	return {
		add: (ws) => {
			clients.add(ws);
			console.log(`[client] connected (${clients.size} total)`);
			ensureCapture();
			// Prime the new client so it can start decoding immediately instead of
			// waiting up to a full GOP for the next keyframe.
			if (lastKeyframe && ws.readyState === ws.OPEN) ws.send(lastKeyframe);
		},
		remove: (ws) => {
			if (!clients.delete(ws)) return;
			console.log(`[client] disconnected (${clients.size} left)`);
			stopIfIdle();
		},
	};
};

const main = () => {
	const cfg = readConfig(process.env);
	const ui = createUinput();
	const broadcaster = startBroadcaster(cfg);
	for (const sig of ["SIGINT", "SIGTERM"] as const)
		process.on(sig, () => {
			ui.destroy();
			process.exit(0);
		});

	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("vnc stream server — connect over ws on this port.\n");
	});
	const wss = new WebSocketServer({ server });

	wss.on("connection", (ws: WebSocket) => {
		broadcaster.add(ws);
		ws.on("message", (raw, isBinary) => {
			if (isBinary) return;
			try {
				const msg = parseInput(JSON.parse(raw.toString()));
				if (msg) injectInput(ui, msg);
			} catch {
				/* malformed frame — ignore */
			}
		});
		const cleanup = () => broadcaster.remove(ws);
		ws.on("close", cleanup);
		ws.on("error", cleanup);
	});

	server.listen(cfg.port, cfg.host, () => {
		console.log(
			`vnc stream server on ws://${cfg.host}:${cfg.port}  output=${cfg.output || "(default)"}  display=${cfg.waylandDisplay}`,
		);
		console.log(
			"Bind this to a WireGuard/VPN interface (or loopback + SSH tunnel) and firewall the LAN — the stream is not encrypted in-process.",
		);
	});
};

main();

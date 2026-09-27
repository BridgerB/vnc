/**
 * Relay stream server — runs ON the wlroots/Hyprland box (Node 23+, runs .ts natively).
 *
 * Pipeline: wf-recorder (wlr-screencopy) -> h264_nvenc -> Annex-B -> per-client
 * over a plain `ws` WebSocket. Browser decodes with WebCodecs.
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
 *   PYTHON=python3            interpreter for the uinput helper (Nix: set PYENV
 *                             to a python env dir, or PYTHON to its python3)
 *   INJECT=<path>             override path to inject.py (default: next to this)
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4735);
const HOST = process.env.HOST ?? "0.0.0.0";
const OUTPUT = process.env.OUTPUT ?? ""; // empty = let wf-recorder pick the default output
const WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY ?? "wayland-1";
const XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? "/run/user/1000";
const BITRATE = process.env.BITRATE ?? "40M";
const GOP = process.env.GOP ?? "120";
const PRESET = process.env.PRESET ?? "p1"; // p1 = fastest encode = lowest latency (40Mbps keeps quality high)

// ---- streaming Annex-B parser --------------------------------------------
// Emits one access unit (frame) at a time: SPS/PPS/SEI prefix + the VCL NAL(s).
class AnnexB {
	buf: Buffer = Buffer.alloc(0);
	au: Buffer[] = [];
	hasVcl = false;
	onFrame: (keyframe: boolean, data: Buffer) => void;
	constructor(onFrame: (keyframe: boolean, data: Buffer) => void) {
		this.onFrame = onFrame;
	}

	push(chunk: Buffer) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		// find start codes (00 00 01) and split into NALs; keep the last partial
		const starts: number[] = [];
		for (let i = 0; i + 2 < this.buf.length; i++) {
			if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) {
				starts.push(i);
				i += 2;
			}
		}
		if (starts.length < 2) return; // need at least one complete NAL boundary
		for (let s = 0; s < starts.length - 1; s++) {
			const from = starts[s];
			let to = starts[s + 1];
			// A NAL body ends before the next start code; trailing 0x00 bytes are
			// padding (trailing_zero_8bits / the leading zero of a 4-byte start
			// code) and are stripped so they don't ride along on this NAL.
			const nalStart = from + 3;
			while (to > nalStart && this.buf[to - 1] === 0) to--;
			this.handleNal(this.buf.subarray(nalStart, to));
		}
		// keep everything from the last start code onward (incomplete NAL)
		this.buf = this.buf.subarray(starts[starts.length - 1]);
	}

	private handleNal(nal: Buffer) {
		if (!nal.length) return;
		const type = nal[0] & 0x1f;
		const isVcl = type === 1 || type === 5;
		// Flush the completed access unit as soon as the *next* AU begins — marked
		// by an access-unit delimiter (9), parameter set / SEI (7/8/6), or another
		// VCL slice — rather than waiting for the next VCL specifically. That saves
		// roughly a frame of pipeline latency.
		const startsNewAu =
			isVcl || type === 9 || type === 7 || type === 8 || type === 6;
		if (this.hasVcl && startsNewAu) this.flush();
		this.au.push(nal);
		if (isVcl) this.hasVcl = true;
	}

	private flush() {
		if (!this.au.length) return;
		const SC = Buffer.from([0, 0, 0, 1]);
		let key = false;
		const parts: Buffer[] = [];
		for (const nal of this.au) {
			if ((nal[0] & 0x1f) === 5) key = true;
			parts.push(SC, nal);
		}
		this.onFrame(key, Buffer.concat(parts));
		this.au = [];
		this.hasVcl = false;
	}
}

// ---- capture process ------------------------------------------------------
function startCapture(
	onFrame: (keyframe: boolean, data: Buffer) => void,
): ChildProcessWithoutNullStreams {
	const args = [
		...(OUTPUT ? ["-o", OUTPUT] : []),
		"-c",
		"h264_nvenc",
		"-m",
		"h264",
		"-x",
		"yuv420p",
		"-f",
		"pipe:1",
		"-p",
		`preset=${PRESET}`,
		"-p",
		"tune=ull", // ultra-low-latency NVENC tuning
		"-p",
		"rc=cbr",
		"-p",
		`b=${BITRATE}`, // NOTE: the codec option is `b`, not `b:v` (that's CLI syntax)
		"-p",
		"bf=0", // no B-frames (no reordering latency)
		"-p",
		"delay=0", // emit each frame immediately, no output delay
		"-p",
		"rc-lookahead=0", // no lookahead buffer
		"-p",
		"no-scenecut=1", // no surprise keyframes -> no latency spikes
		"-p",
		`g=${GOP}`,
		// signal full-range BT.709 so WebCodecs decodes colors correctly (capture is full-range RGB)
		"-p",
		"color_range=pc",
		"-p",
		"colorspace=bt709",
		"-p",
		"color_primaries=bt709",
		"-p",
		"color_trc=bt709",
	];
	const child = spawn("wf-recorder", args, {
		env: { ...process.env, WAYLAND_DISPLAY, XDG_RUNTIME_DIR },
		stdio: ["ignore", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	const parser = new AnnexB(onFrame);
	child.stdout.on("data", (d: Buffer) => parser.push(d));
	child.stderr.on("data", (d: Buffer) => {
		const s = d.toString();
		if (/error|failed|invalid/i.test(s))
			console.error("[wf-recorder]", s.trim());
	});
	child.on("exit", (code) => console.log("[capture] wf-recorder exited", code));
	return child;
}

// ---- input injection via a persistent uinput helper (kernel-level) --------
// One shared Python/evdev process (held keys stay held; no per-event spawn).
// PYTHON wins; else a Nix PYENV dir's python3; else python3 on PATH.
const PYTHON =
	process.env.PYTHON ??
	(process.env.PYENV ? `${process.env.PYENV}/bin/python3` : "python3");
const INJECT = process.env.INJECT ?? path.join(HERE, "inject.py");
/** @type {ChildProcessWithoutNullStreams | null} */
let helper: ChildProcessWithoutNullStreams | null = null;
function startHelper() {
	helper = spawn(PYTHON, [INJECT], {
		env: { ...process.env, WAYLAND_DISPLAY, XDG_RUNTIME_DIR },
		stdio: ["pipe", "ignore", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	helper.stderr.on("data", (d: Buffer) =>
		console.log("[input]", d.toString().trim()),
	);
	helper.on("exit", (code) => {
		console.log("[input] helper exited", code, "— restarting");
		helper = null;
		setTimeout(startHelper, 500);
	});
}
function hcmd(line: string) {
	if (helper?.stdin.writable) helper.stdin.write(`${line}\n`);
}

// Input messages from the browser, as a discriminated union on `t`.
type InputMsg =
	| { t: "a"; x: number; y: number } // absolute pointer, x/y in 0..65535
	| { t: "m"; dx: number; dy: number } // relative move
	| { t: "btn"; b: number; down: boolean } // button b=0/1/2
	| { t: "wheel"; dy?: number; dx?: number } // dy vertical (+up), dx horizontal
	| { t: "key"; code: number; down: boolean }; // code = Linux keycode

const int = (v: unknown) => (typeof v === "number" ? v | 0 : 0);

// Parse untrusted JSON into an InputMsg, or null if it isn't one (§3 parse, don't validate).
function parseInput(raw: unknown): InputMsg | null {
	if (typeof raw !== "object" || raw === null) return null;
	const m = raw as Record<string, unknown>;
	switch (m.t) {
		case "a":
			return { t: "a", x: int(m.x), y: int(m.y) };
		case "m":
			return { t: "m", dx: int(m.dx), dy: int(m.dy) };
		case "btn":
			return { t: "btn", b: int(m.b), down: !!m.down };
		case "wheel":
			return { t: "wheel", dy: int(m.dy), dx: int(m.dx) };
		case "key":
			return { t: "key", code: int(m.code), down: !!m.down };
		default:
			return null;
	}
}

function injectInput(m: InputMsg) {
	switch (m.t) {
		case "a":
			hcmd(`a ${m.x} ${m.y}`);
			return;
		case "m":
			hcmd(`m ${m.dx} ${m.dy}`);
			return;
		case "btn":
			hcmd(`${m.down ? "d" : "u"} ${m.b}`);
			return;
		case "wheel":
			if (m.dy) hcmd(`w ${m.dy}`);
			if (m.dx) hcmd(`hw ${m.dx}`);
			return;
		case "key":
			hcmd(`${m.down ? "kd" : "ku"} ${m.code}`);
			return;
		default:
			return assertNever(m);
	}
}

const assertNever = (x: never): never => {
	throw new Error(`unreachable input: ${JSON.stringify(x)}`);
};

// ---- server ---------------------------------------------------------------
const server = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("Relay stream server — connect over ws on this port.\n");
});
const wss = new WebSocketServer({ server });

// One shared capture/encoder fanned out to every client. A consumer NVIDIA GPU
// caps concurrent NVENC sessions, and re-capturing the same screen per client
// wastes GPU and bandwidth — so we encode once and broadcast.
const clients = new Set<WebSocket>();
let capture: ChildProcessWithoutNullStreams | null = null;
let lastKeyframe: Buffer | null = null; // framed, ready to prime a new client

/** Frame an access unit: [u8 keyframe][u32 timestamp-ms] then the Annex-B AU. */
function frameAu(keyframe: boolean, data: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head[0] = keyframe ? 1 : 0;
	head.writeUInt32BE(Date.now() >>> 0, 1);
	return Buffer.concat([head, data]);
}

function ensureCapture() {
	if (capture) return;
	console.log("[capture] starting shared encoder");
	capture = startCapture((keyframe, data) => {
		const framed = frameAu(keyframe, data);
		if (keyframe) lastKeyframe = framed;
		for (const ws of clients) {
			if (ws.readyState === ws.OPEN) ws.send(framed);
		}
	});
	capture.on("exit", (code) => {
		capture = null;
		lastKeyframe = null;
		if (clients.size > 0) {
			console.log("[capture] exited unexpectedly, restarting", code);
			setTimeout(ensureCapture, 500);
		}
	});
}

wss.on("connection", (ws: WebSocket) => {
	clients.add(ws);
	console.log(`[client] connected (${clients.size} total)`);
	ensureCapture();
	// Prime the new client with the most recent keyframe so it can start decoding
	// immediately instead of waiting up to a full GOP for the next one.
	if (lastKeyframe && ws.readyState === ws.OPEN) ws.send(lastKeyframe);

	ws.on("message", (raw, isBinary) => {
		if (isBinary) return;
		try {
			const msg = parseInput(JSON.parse(raw.toString()));
			if (msg) injectInput(msg);
		} catch {
			/* malformed frame — ignore */
		}
	});
	const cleanup = () => {
		if (!clients.delete(ws)) return;
		console.log(`[client] disconnected (${clients.size} left)`);
		if (clients.size === 0 && capture) {
			console.log("[capture] no clients; stopping encoder");
			capture.kill("SIGINT");
			capture = null;
			lastKeyframe = null;
		}
	};
	ws.on("close", cleanup);
	ws.on("error", cleanup);
});

startHelper();
server.listen(PORT, HOST, () => {
	console.log(
		`Relay stream server on ws://${HOST}:${PORT}  output=${OUTPUT || "(default)"}  display=${WAYLAND_DISPLAY}`,
	);
	console.log(
		"Bind this to a WireGuard/VPN interface (or loopback + SSH tunnel) and firewall the LAN — the stream is not encrypted in-process.",
	);
});

import { EventEmitter } from "node:events";
import net from "node:net";
import { Inflate } from "pako";
import { decodeCursor, decodeRaw, decodeZrle } from "./decoders.ts";
import { desEncryptBlock } from "./des.ts";

const Z_SYNC_FLUSH = 2;

// Client->server message types
const MSG_SET_PIXEL_FORMAT = 0;
const MSG_SET_ENCODINGS = 2;
const MSG_FB_UPDATE_REQUEST = 3;
const MSG_KEY_EVENT = 4;
const MSG_POINTER_EVENT = 5;
const MSG_CLIENT_CUT_TEXT = 6;
const MSG_ENABLE_CONTINUOUS_UPDATES = 150;
const MSG_CLIENT_FENCE = 248;

// Server->client message types
const SMSG_FB_UPDATE = 0;
const SMSG_SET_COLOUR_MAP = 1;
const SMSG_BELL = 2;
const SMSG_CUT_TEXT = 3;
const SMSG_END_CONTINUOUS_UPDATES = 150;
const SMSG_FENCE = 248;

// Encodings
const ENC_RAW = 0;
const ENC_COPYRECT = 1;
const ENC_ZRLE = 16;
const ENC_CURSOR = -239;
const ENC_DESKTOP_SIZE = -223;
const ENC_FENCE = -312;
const ENC_CONTINUOUS_UPDATES = -313;

const FENCE_REQUEST = 0x80000000;

const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;

// Security types the browser prefers, in order.
const DEFAULT_ENCODINGS = [
	ENC_COPYRECT,
	ENC_ZRLE,
	ENC_RAW,
	ENC_CURSOR,
	ENC_DESKTOP_SIZE,
	ENC_CONTINUOUS_UPDATES,
	ENC_FENCE,
];

// ---- public data types ---------------------------------------------------

export interface RfbOptions {
	host?: string;
	port?: number;
	password?: string;
	shared?: boolean;
	encodings?: number[];
}

export interface RfbInit {
	width: number;
	height: number;
	name: string;
}

export interface RfbSize {
	width: number;
	height: number;
}

/** A decoded RGBA rectangle. */
export interface PixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
	data: Buffer;
}

/** A CopyRect: blit an existing region instead of sending pixels. */
export interface CopyRect {
	x: number;
	y: number;
	width: number;
	height: number;
	copy: { srcX: number; srcY: number };
}

export type Rect = PixelRect | CopyRect;

export interface CursorImage {
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	data: Buffer;
}

/** The events RfbClient emits, with their payloads. */
interface RfbEvents {
	connected: () => void;
	init: (info: RfbInit) => void;
	resize: (size: RfbSize) => void;
	rect: (rect: Rect) => void;
	cursor: (cursor: CursorImage) => void;
	bell: () => void;
	cuttext: (text: string) => void;
	updateDone: () => void;
	continuousupdates: () => void;
	error: (err: Error) => void;
	close: () => void;
}

type State =
	| "version"
	| "security"
	| "vncAuth"
	| "vncChallenge"
	| "vncAuthResult"
	| "securityResult"
	| "serverInit"
	| "message"
	| "fbUpdate"
	| "rect";

type RectHeader = { x: number; y: number; w: number; h: number; enc: number };

// Typed event surface merged onto the class below. This is the standard way to
// give an EventEmitter typed events: the interface only adds event-name
// overloads for on/once/off/emit, and every class field is initialised in the
// constructor, so the merge is safe (suppression is on the class declaration).
export interface RfbClient {
	on<E extends keyof RfbEvents>(event: E, listener: RfbEvents[E]): this;
	once<E extends keyof RfbEvents>(event: E, listener: RfbEvents[E]): this;
	off<E extends keyof RfbEvents>(event: E, listener: RfbEvents[E]): this;
	emit<E extends keyof RfbEvents>(
		event: E,
		...args: Parameters<RfbEvents[E]>
	): boolean;
}

/**
 * A minimal RFB (VNC) protocol client: connects over TCP, performs the RFB
 * 3.3/3.7/3.8 handshake (None + VNC Authentication), then streams
 * FramebufferUpdate messages, decoding Raw / CopyRect / ZRLE / Cursor.
 *
 * It wraps a live TCP socket, so per CODE_STYLE §1 (a resource with an
 * open/close lifecycle) a class is the honest shape here.
 *
 * The requested pixel format is 32bpp true-colour with byte order R,G,B,X so the
 * decoded bytes map straight onto a browser ImageData buffer (alpha forced 255).
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: typed EventEmitter surface (see the RfbClient interface above)
export class RfbClient extends EventEmitter {
	readonly host: string;
	readonly port: number;
	readonly password: string;
	readonly shared: boolean;
	readonly encodings: number[];

	private socket: net.Socket | null = null;
	private buf: Buffer = Buffer.alloc(0);
	private state: State = "version";
	private width = 0;
	private height = 0;
	private name = "";
	private clientMinor = 8;
	private serverMinor = 8;
	private stepVncChallenge?: () => boolean;

	// FramebufferUpdate parsing state.
	private rectsRemaining = 0;
	private rect: RectHeader | null = null;

	// One persistent zlib stream shared across every ZRLE rectangle for the whole
	// connection (required by the ZRLE spec — never reset it). pako's pure-JS
	// inflate is used deliberately: a network-facing decoder must reject malformed
	// input safely, and driving node:zlib's native handle directly aborts the
	// process on a zlib error instead of throwing.
	private readonly inflate = new Inflate();
	private inflateChunks: Buffer[] = [];

	// Set once the server confirms it will push updates without per-frame requests.
	private continuousUpdates = false;

	constructor(opts: RfbOptions = {}) {
		super();
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? 5900;
		this.password = opts.password ?? "";
		this.shared = opts.shared ?? true;
		this.encodings = opts.encodings ?? DEFAULT_ENCODINGS;

		this.inflate.onData = (chunk) =>
			this.inflateChunks.push(Buffer.from(chunk));
		this.inflate.onEnd = () => {};
	}

	connect(): this {
		this.socket = net.connect(this.port, this.host);
		this.socket.on("connect", () => this.emit("connected"));
		this.socket.on("data", (d: Buffer) => this.onData(d));
		this.socket.on("error", (e) => this.emit("error", e));
		this.socket.on("close", () => this.emit("close"));
		return this;
	}

	close() {
		this.socket?.destroy();
	}

	private write(b: Buffer) {
		if (this.socket && !this.socket.destroyed) this.socket.write(b);
	}

	private onData(d: Buffer) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
		try {
			// Loop while we can make progress; each step returns true if it consumed
			// a complete unit, false if it needs more bytes.
			while (this.step()) {}
		} catch (e) {
			this.emit("error", e instanceof Error ? e : new Error(String(e)));
			this.close();
		}
	}

	private take(n: number): Buffer | null {
		if (this.buf.length < n) return null;
		const out = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return out;
	}

	private step(): boolean {
		switch (this.state) {
			case "version":
				return this.stepVersion();
			case "security":
				return this.stepSecurity();
			case "vncChallenge":
				return this.stepVncChallenge ? this.stepVncChallenge() : false;
			case "vncAuth":
			case "vncAuthResult":
			case "securityResult":
				return this.stepSecurityResult();
			case "serverInit":
				return this.stepServerInit();
			case "message":
				return this.stepMessage();
			case "fbUpdate":
				return this.stepFbUpdate();
			case "rect":
				return this.stepRect();
			default:
				return false;
		}
	}

	private stepVersion(): boolean {
		const v = this.take(12);
		if (!v) return false;
		const str = v.toString("latin1"); // e.g. "RFB 003.008\n"
		const minor = Number.parseInt(str.slice(8, 11), 10);
		this.serverMinor = Number.isFinite(minor) ? minor : 8;
		// Respond with the highest version we support that the server offers.
		const useMinor = this.serverMinor >= 8 ? 8 : this.serverMinor >= 7 ? 7 : 3;
		this.clientMinor = useMinor;
		this.write(Buffer.from(`RFB 003.00${useMinor}\n`, "latin1"));
		this.state = "security";
		return true;
	}

	private stepSecurity(): boolean {
		if (this.clientMinor >= 7) {
			// 3.7+/3.8: server sends count then list of security types.
			if (this.buf.length < 1) return false;
			const count = this.buf[0];
			if (count === 0) {
				// Followed by a reason string.
				if (this.buf.length < 5) return false;
				const len = this.buf.readUInt32BE(1);
				if (this.buf.length < 5 + len) return false;
				const reason = this.buf.subarray(5, 5 + len).toString("latin1");
				throw new Error(`Server refused connection: ${reason}`);
			}
			if (this.buf.length < 1 + count) return false;
			const types = [...this.buf.subarray(1, 1 + count)];
			this.take(1 + count);
			this.chooseSecurity(types);
			return true;
		}
		// 3.3: server dictates a single 4-byte security type.
		if (this.buf.length < 4) return false;
		const type = this.buf.readUInt32BE(0);
		this.take(4);
		if (type === 0) throw new Error("Connection failed (security type 0)");
		this.beginSecurity(type);
		return true;
	}

	private chooseSecurity(types: number[]) {
		// Prefer None (1), else VNC Authentication (2).
		let chosen: number | null = null;
		if (types.includes(SECURITY_NONE) && !this.password) chosen = SECURITY_NONE;
		else if (types.includes(SECURITY_VNC_AUTH)) chosen = SECURITY_VNC_AUTH;
		else if (types.includes(SECURITY_NONE)) chosen = SECURITY_NONE;
		if (chosen === null)
			throw new Error(
				`No supported security type; server offered ${types.join(",")}`,
			);
		this.write(Buffer.from([chosen]));
		this.beginSecurity(chosen);
	}

	private beginSecurity(type: number) {
		if (type === SECURITY_NONE) {
			// None. In 3.8 a SecurityResult follows; in 3.3/3.7 it does not.
			if (this.clientMinor >= 8) this.state = "securityResult";
			else {
				this.sendClientInit();
				this.state = "serverInit";
			}
		} else if (type === SECURITY_VNC_AUTH) {
			this.awaitChallenge();
		} else {
			throw new Error(`Unsupported security type ${type}`);
		}
	}

	private awaitChallenge() {
		// Consume the 16-byte challenge as soon as it arrives via a one-off state.
		this.state = "vncChallenge";
		this.stepVncChallenge = () => {
			const ch = this.take(16);
			if (!ch) return false;
			this.write(vncEncryptChallenge(this.password, ch));
			this.state = "securityResult";
			return true;
		};
	}

	private stepSecurityResult(): boolean {
		if (this.state === "vncChallenge")
			return this.stepVncChallenge ? this.stepVncChallenge() : false;
		const r = this.take(4);
		if (!r) return false;
		const result = r.readUInt32BE(0);
		if (result !== 0) {
			// 3.8 includes a reason string.
			if (this.clientMinor >= 8) {
				if (this.buf.length < 4) return false;
				const len = this.buf.readUInt32BE(0);
				if (this.buf.length < 4 + len) return false;
				const reason = this.buf.subarray(4, 4 + len).toString("latin1");
				throw new Error(`Authentication failed: ${reason}`);
			}
			throw new Error("Authentication failed");
		}
		this.sendClientInit();
		this.state = "serverInit";
		return true;
	}

	private sendClientInit() {
		this.write(Buffer.from([this.shared ? 1 : 0]));
	}

	private stepServerInit(): boolean {
		if (this.buf.length < 24) return false;
		const nameLen = this.buf.readUInt32BE(20);
		if (this.buf.length < 24 + nameLen) return false;
		const b = this.take(24 + nameLen);
		if (!b) return false;
		this.width = b.readUInt16BE(0);
		this.height = b.readUInt16BE(2);
		// Server's native pixel format is at b[4..20]; we override it below.
		this.name = b.subarray(24, 24 + nameLen).toString("utf8");

		this.sendSetPixelFormat();
		this.sendSetEncodings(this.encodings);
		this.emit("init", {
			width: this.width,
			height: this.height,
			name: this.name,
		});
		this.requestUpdate(false); // initial full-screen (non-incremental) update
		// Ask the server to stream changes without a request per frame. Servers that
		// don't support it ignore this and never send EndOfContinuousUpdates, so we
		// transparently fall back to the pull loop.
		this.enableContinuousUpdates(true);
		this.state = "message";
		return true;
	}

	/** Enable/disable server-pushed continuous updates for the whole screen. */
	enableContinuousUpdates(enable = true) {
		const b = Buffer.alloc(10);
		b[0] = MSG_ENABLE_CONTINUOUS_UPDATES;
		b[1] = enable ? 1 : 0;
		b.writeUInt16BE(0, 2);
		b.writeUInt16BE(0, 4);
		b.writeUInt16BE(this.width, 6);
		b.writeUInt16BE(this.height, 8);
		this.write(b);
	}

	/** Echo a fence back to the server (flow control). */
	private sendFence(flags: number, payload: Buffer) {
		const b = Buffer.alloc(9 + payload.length);
		b[0] = MSG_CLIENT_FENCE;
		b.writeUInt32BE(flags >>> 0, 4);
		b[8] = payload.length;
		payload.copy(b, 9);
		this.write(b);
	}

	private sendSetPixelFormat() {
		// 32bpp true colour, little-endian, byte order R,G,B,X (shifts 0/8/16).
		const b = Buffer.alloc(20);
		b[0] = MSG_SET_PIXEL_FORMAT;
		b[4] = 32; // bits-per-pixel
		b[5] = 24; // depth
		b[6] = 0; // big-endian flag
		b[7] = 1; // true-colour flag
		b.writeUInt16BE(255, 8); // red max
		b.writeUInt16BE(255, 10); // green max
		b.writeUInt16BE(255, 12); // blue max
		b[14] = 0; // red shift
		b[15] = 8; // green shift
		b[16] = 16; // blue shift
		this.write(b);
	}

	private sendSetEncodings(encs: number[]) {
		const b = Buffer.alloc(4 + encs.length * 4);
		b[0] = MSG_SET_ENCODINGS;
		b.writeUInt16BE(encs.length, 2);
		for (let i = 0; i < encs.length; i++) b.writeInt32BE(encs[i], 4 + i * 4);
		this.write(b);
	}

	/** Request a framebuffer update (full screen). incremental=true for deltas. */
	requestUpdate(incremental = true) {
		const b = Buffer.alloc(10);
		b[0] = MSG_FB_UPDATE_REQUEST;
		b[1] = incremental ? 1 : 0;
		b.writeUInt16BE(0, 2);
		b.writeUInt16BE(0, 4);
		b.writeUInt16BE(this.width, 6);
		b.writeUInt16BE(this.height, 8);
		this.write(b);
	}

	// ---- server message dispatch ----

	private stepMessage(): boolean {
		if (this.buf.length < 1) return false;
		const type = this.buf[0];
		switch (type) {
			case SMSG_FB_UPDATE: {
				// type(1) pad(1) nrects(2)
				if (this.buf.length < 4) return false;
				this.rectsRemaining = this.buf.readUInt16BE(2);
				this.take(4);
				this.state = "fbUpdate";
				return true;
			}
			case SMSG_BELL: {
				this.take(1);
				this.emit("bell");
				return true;
			}
			case SMSG_SET_COLOUR_MAP: {
				// type(1) pad(1) firstColour(2) nColours(2) then nColours*6
				if (this.buf.length < 6) return false;
				const n = this.buf.readUInt16BE(4);
				if (this.buf.length < 6 + n * 6) return false;
				this.take(6 + n * 6); // ignore; we use true colour
				return true;
			}
			case SMSG_CUT_TEXT: {
				// type(1) pad(3) len(4) text
				if (this.buf.length < 8) return false;
				const len = this.buf.readUInt32BE(4);
				if (this.buf.length < 8 + len) return false;
				const text = this.buf.subarray(8, 8 + len).toString("latin1");
				this.take(8 + len);
				this.emit("cuttext", text);
				return true;
			}
			case SMSG_END_CONTINUOUS_UPDATES: {
				// type(1) only — server confirms it will push updates without requests.
				this.take(1);
				this.continuousUpdates = true;
				this.emit("continuousupdates");
				return true;
			}
			case SMSG_FENCE: {
				// type(1) pad(3) flags(4) length(1) payload(length)
				if (this.buf.length < 9) return false;
				const flags = this.buf.readUInt32BE(4);
				const len = this.buf[8];
				if (this.buf.length < 9 + len) return false;
				const payload = Buffer.from(this.buf.subarray(9, 9 + len));
				this.take(9 + len);
				// If the server requested a response, echo the fence (minus the request
				// bit) so it knows we're keeping up.
				if (flags & FENCE_REQUEST)
					this.sendFence(flags & ~FENCE_REQUEST, payload);
				return true;
			}
			default:
				throw new Error(`Unknown server message type ${type}`);
		}
	}

	private stepFbUpdate(): boolean {
		if (this.rectsRemaining === 0) {
			this.state = "message";
			this.emit("updateDone");
			return true;
		}
		// Read a 12-byte rectangle header.
		if (this.buf.length < 12) return false;
		const x = this.buf.readUInt16BE(0);
		const y = this.buf.readUInt16BE(2);
		const w = this.buf.readUInt16BE(4);
		const h = this.buf.readUInt16BE(6);
		const enc = this.buf.readInt32BE(8);
		this.take(12);
		this.rect = { x, y, w, h, enc };
		this.state = "rect";
		return true;
	}

	private stepRect(): boolean {
		const r = this.rect;
		if (!r) return false;
		switch (r.enc) {
			case ENC_RAW: {
				const size = r.w * r.h * 4;
				if (this.buf.length < size) return false;
				const px = this.take(size);
				if (!px) return false;
				this.emit("rect", {
					x: r.x,
					y: r.y,
					width: r.w,
					height: r.h,
					data: decodeRaw(px, r.w, r.h),
				});
				return this.rectDone();
			}
			case ENC_COPYRECT: {
				if (this.buf.length < 4) return false;
				const src = this.take(4);
				if (!src) return false;
				this.emit("rect", {
					x: r.x,
					y: r.y,
					width: r.w,
					height: r.h,
					copy: { srcX: src.readUInt16BE(0), srcY: src.readUInt16BE(2) },
				});
				return this.rectDone();
			}
			case ENC_ZRLE: {
				// u32 length, then that many bytes of the persistent zlib stream.
				if (this.buf.length < 4) return false;
				const len = this.buf.readUInt32BE(0);
				if (this.buf.length < 4 + len) return false;
				const comp = this.buf.subarray(4, 4 + len);
				this.take(4 + len);
				this.inflateChunks = [];
				this.inflate.push(comp, Z_SYNC_FLUSH);
				if (this.inflate.err)
					throw new Error(`ZRLE inflate failed: ${this.inflate.msg}`);
				const data =
					this.inflateChunks.length === 1
						? this.inflateChunks[0]
						: Buffer.concat(this.inflateChunks);
				this.emit("rect", {
					x: r.x,
					y: r.y,
					width: r.w,
					height: r.h,
					data: decodeZrle(data, r.w, r.h),
				});
				return this.rectDone();
			}
			case ENC_CURSOR: {
				// body: w*h*4 pixels + floor((w+7)/8)*h mask
				const bodyLen = r.w * r.h * 4 + Math.floor((r.w + 7) / 8) * r.h;
				if (this.buf.length < bodyLen) return false;
				const body = this.take(bodyLen);
				if (!body) return false;
				const data =
					r.w && r.h ? decodeCursor(body, r.w, r.h) : Buffer.alloc(0);
				this.emit("cursor", {
					width: r.w,
					height: r.h,
					hotspotX: r.x,
					hotspotY: r.y,
					data,
				});
				return this.rectDone();
			}
			case ENC_DESKTOP_SIZE: {
				this.width = r.w;
				this.height = r.h;
				// Re-arm continuous updates for the new screen size.
				if (this.continuousUpdates) this.enableContinuousUpdates(true);
				this.emit("resize", { width: r.w, height: r.h });
				return this.rectDone();
			}
			default:
				throw new Error(`Unsupported encoding ${r.enc} at ${r.x},${r.y}`);
		}
	}

	private rectDone(): boolean {
		this.rect = null;
		this.rectsRemaining--;
		this.state = "fbUpdate";
		return true;
	}

	// ---- input events (client -> server) ----

	/** buttonMask bit0=left,bit1=middle,bit2=right,bit3=wheelUp,bit4=wheelDown */
	pointerEvent(x: number, y: number, buttonMask: number) {
		const b = Buffer.alloc(6);
		b[0] = MSG_POINTER_EVENT;
		b[1] = buttonMask & 0xff;
		b.writeUInt16BE(Math.max(0, Math.min(0xffff, x | 0)), 2);
		b.writeUInt16BE(Math.max(0, Math.min(0xffff, y | 0)), 4);
		this.write(b);
	}

	keyEvent(keysym: number, down: boolean) {
		const b = Buffer.alloc(8);
		b[0] = MSG_KEY_EVENT;
		b[1] = down ? 1 : 0;
		b.writeUInt32BE(keysym >>> 0, 4);
		this.write(b);
	}

	/** Send clipboard text to the server. */
	cutText(text: string) {
		const bytes = Buffer.from(text, "latin1");
		const b = Buffer.alloc(8 + bytes.length);
		b[0] = MSG_CLIENT_CUT_TEXT;
		b.writeUInt32BE(bytes.length, 4);
		bytes.copy(b, 8);
		this.write(b);
	}
}

/**
 * VNC Authentication: DES-encrypt the 16-byte challenge with the password as the
 * key. Each key byte's bits are reversed (a quirk of the original VNC code).
 * Only the first 8 characters of the password are used (the DES key size).
 * Exported for unit testing.
 */
export const vncEncryptChallenge = (
	password: string,
	challenge: Buffer,
): Buffer => {
	const key = Buffer.alloc(8);
	for (let i = 0; i < 8; i++) key[i] = reverseBits(password.charCodeAt(i) || 0);
	const out = Buffer.alloc(16);
	for (let off = 0; off < 16; off += 8) {
		const block = desEncryptBlock(key, challenge.subarray(off, off + 8));
		Buffer.from(block.buffer, block.byteOffset, block.length).copy(out, off);
	}
	return out;
};

/** Reverse the 8 bits of a byte (exported for unit testing). */
export const reverseBits = (b: number): number => {
	let r = 0;
	for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
	return r & 0xff;
};

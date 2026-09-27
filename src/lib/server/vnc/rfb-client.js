import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { Inflate } from "pako";
import { decodeCursor, decodeRaw, decodeZrle } from "./decoders.js";

const Z_SYNC_FLUSH = 2;

/**
 * A minimal RFB (VNC) protocol client.
 *
 * Connects over TCP, performs the RFB 3.3/3.7/3.8 handshake (None + VNC
 * Authentication security), then streams FramebufferUpdate messages, decoding
 * Raw and CopyRect encodings into RGBA rectangles.
 *
 * Events:
 *   'init'   ({ width, height, name })            — after ServerInit
 *   'resize' ({ width, height })                  — desktop size change
 *   'rect'   ({ x, y, width, height, data })      — a decoded RGBA rectangle
 *            or ({ x, y, width, height, copy: { srcX, srcY } }) for CopyRect
 *   'bell'   ()
 *   'cuttext'(string)                             — server clipboard
 *   'error'  (Error)
 *   'close'  ()
 *
 * We request a pixel format of 32bpp true-colour with byte order R,G,B,X so the
 * decoded bytes map straight onto a browser ImageData buffer (alpha forced 255).
 */

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

export class RfbClient extends EventEmitter {
	/** @param {{ host?: string, port?: number, password?: string, shared?: boolean, encodings?: number[] }} opts */
	constructor(opts = {}) {
		super();
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? 5900;
		this.password = opts.password ?? "";
		this.shared = opts.shared ?? true;

		/** @type {import('net').Socket | null} */
		this.socket = null;
		/** @type {Buffer} */
		this.buf = Buffer.alloc(0);
		this.state = "version";
		this.width = 0;
		this.height = 0;
		this.name = "";
		this.clientMinor = 8;
		this.serverMinor = 8;
		/** @type {(() => boolean) | undefined} */
		this._stepVncChallenge = undefined;

		// FramebufferUpdate parsing state
		this._rectsRemaining = 0;
		/** @type {{ x: number, y: number, w: number, h: number, enc: number } | null} */
		this._rect = null; // current rect header being decoded

		// Persistent zlib stream shared across every ZRLE rectangle for the whole
		// connection (this is required by the ZRLE spec — never reset it).
		this._inflate = new Inflate();
		/** @type {Buffer[]} */
		this._inflateChunks = [];
		this._inflate.onData = (chunk) =>
			this._inflateChunks.push(Buffer.from(chunk));
		this._inflate.onEnd = () => {};

		this.encodings = opts.encodings ?? [
			ENC_COPYRECT,
			ENC_ZRLE,
			ENC_RAW,
			ENC_CURSOR,
			ENC_DESKTOP_SIZE,
			ENC_CONTINUOUS_UPDATES,
			ENC_FENCE,
		];
		// Set once the server confirms it will push updates without per-frame
		// requests (EndOfContinuousUpdates). Lets the bridge drop the pull loop.
		this._continuousUpdates = false;
	}

	connect() {
		this.socket = net.connect(this.port, this.host);
		this.socket.on("connect", () => this.emit("connected"));
		this.socket.on("data", (d) => this._onData(/** @type {Buffer} */ (d)));
		this.socket.on("error", (e) => this.emit("error", e));
		this.socket.on("close", () => this.emit("close"));
		return this;
	}

	close() {
		if (this.socket) this.socket.destroy();
	}

	/** @param {Buffer} d */
	_onData(d) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
		try {
			// Loop while we can make progress; each step returns true if it
			// consumed a complete unit, false if it needs more bytes.
			// eslint-disable-next-line no-empty
			while (this._step()) {}
		} catch (e) {
			this.emit("error", e instanceof Error ? e : new Error(String(e)));
			this.close();
		}
	}

	/** @param {number} n */
	_take(n) {
		if (this.buf.length < n) return null;
		const out = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return out;
	}

	_step() {
		switch (this.state) {
			case "version":
				return this._stepVersion();
			case "security":
				return this._stepSecurity();
			case "vncChallenge":
				return this._stepVncChallenge ? this._stepVncChallenge() : false;
			case "vncAuthResult":
				return this._stepSecurityResult();
			case "securityResult":
				return this._stepSecurityResult();
			case "serverInit":
				return this._stepServerInit();
			case "message":
				return this._stepMessage();
			case "fbUpdate":
				return this._stepFbUpdate();
			case "rect":
				return this._stepRect();
			default:
				return false;
		}
	}

	_stepVersion() {
		const v = this._take(12);
		if (!v) return false;
		const str = v.toString("latin1"); // e.g. "RFB 003.008\n"
		const minor = parseInt(str.slice(8, 11), 10);
		this.serverMinor = Number.isFinite(minor) ? minor : 8;
		// Respond with the highest version we support that the server offers.
		const useMinor = this.serverMinor >= 8 ? 8 : this.serverMinor >= 7 ? 7 : 3;
		this.clientMinor = useMinor;
		this.socket?.write(Buffer.from(`RFB 003.00${useMinor}\n`, "latin1"));
		this.state = "security";
		return true;
	}

	_stepSecurity() {
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
			this._take(1 + count);
			this._chooseSecurity(types);
			return true;
		} else {
			// 3.3: server dictates a single 4-byte security type.
			if (this.buf.length < 4) return false;
			const type = this.buf.readUInt32BE(0);
			this._take(4);
			if (type === 0) throw new Error("Connection failed (security type 0)");
			this._beginSecurity(type, /* send */ false);
			return true;
		}
	}

	/** @param {number[]} types */
	_chooseSecurity(types) {
		// Prefer None (1), else VNC Authentication (2).
		let chosen = null;
		if (types.includes(1) && !this.password) chosen = 1;
		else if (types.includes(2)) chosen = 2;
		else if (types.includes(1)) chosen = 1;
		if (chosen == null)
			throw new Error(
				`No supported security type; server offered ${types.join(",")}`,
			);
		this.socket?.write(Buffer.from([chosen]));
		this._beginSecurity(chosen, /* send */ true);
	}

	/** @param {number} type @param {boolean} _sent */
	_beginSecurity(type, _sent) {
		if (type === 1) {
			// None. In 3.8 a SecurityResult follows; in 3.3/3.7 it does not.
			if (this.clientMinor >= 8) this.state = "securityResult";
			else {
				this._sendClientInit();
				this.state = "serverInit";
			}
		} else if (type === 2) {
			this.state = "vncAuth";
			// Need the 16-byte challenge; handle inline here since it's simple.
			this._awaitChallenge();
		} else {
			throw new Error(`Unsupported security type ${type}`);
		}
	}

	_awaitChallenge() {
		// Consume the 16-byte challenge as soon as it arrives via a one-off state.
		this.state = "vncChallenge";
		// Reuse the step loop: add handling.
		this._stepVncChallenge = () => {
			const ch = this._take(16);
			if (!ch) return false;
			const resp = vncEncryptChallenge(this.password, ch);
			this.socket?.write(resp);
			this.state = "securityResult";
			return true;
		};
	}

	_stepSecurityResult() {
		if (this.state === "vncChallenge")
			return this._stepVncChallenge ? this._stepVncChallenge() : false;
		const r = this._take(4);
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
		this._sendClientInit();
		this.state = "serverInit";
		return true;
	}

	_sendClientInit() {
		this.socket?.write(Buffer.from([this.shared ? 1 : 0]));
	}

	_stepServerInit() {
		if (this.buf.length < 24) return false;
		const nameLen = this.buf.readUInt32BE(20);
		if (this.buf.length < 24 + nameLen) return false;
		const b = this._take(24 + nameLen);
		if (!b) return false;
		this.width = b.readUInt16BE(0);
		this.height = b.readUInt16BE(2);
		// Server's native pixel format is at b[4..20]; we override it below.
		this.name = b.subarray(24, 24 + nameLen).toString("utf8");

		this._sendSetPixelFormat();
		this._sendSetEncodings(this.encodings);
		this.emit("init", {
			width: this.width,
			height: this.height,
			name: this.name,
		});
		this.requestUpdate(false); // initial full-screen (non-incremental) update
		// Ask the server to stream changes without a request per frame. Servers
		// that don't support it ignore this and never send EndOfContinuousUpdates,
		// so we transparently fall back to the pull loop.
		this.enableContinuousUpdates(true);
		this.state = "message";
		return true;
	}

	/**
	 * Enable/disable server-pushed continuous updates for the whole screen.
	 * @param {boolean} enable
	 */
	enableContinuousUpdates(enable = true) {
		const b = Buffer.alloc(10);
		b[0] = MSG_ENABLE_CONTINUOUS_UPDATES;
		b[1] = enable ? 1 : 0;
		b.writeUInt16BE(0, 2);
		b.writeUInt16BE(0, 4);
		b.writeUInt16BE(this.width, 6);
		b.writeUInt16BE(this.height, 8);
		if (this.socket && !this.socket.destroyed) this.socket.write(b);
	}

	/** Echo a fence back to the server (flow control). @param {number} flags @param {Buffer} payload */
	_sendFence(flags, payload) {
		const b = Buffer.alloc(9 + payload.length);
		b[0] = MSG_CLIENT_FENCE;
		b.writeUInt32BE(flags >>> 0, 4);
		b[8] = payload.length;
		payload.copy(b, 9);
		if (this.socket && !this.socket.destroyed) this.socket.write(b);
	}

	_sendSetPixelFormat() {
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
		this.socket?.write(b);
	}

	/** @param {number[]} encs */
	_sendSetEncodings(encs) {
		const b = Buffer.alloc(4 + encs.length * 4);
		b[0] = MSG_SET_ENCODINGS;
		b.writeUInt16BE(encs.length, 2);
		for (let i = 0; i < encs.length; i++) b.writeInt32BE(encs[i], 4 + i * 4);
		this.socket?.write(b);
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
		if (this.socket && !this.socket.destroyed) this.socket?.write(b);
	}

	// ---- Server message dispatch ----

	_stepMessage() {
		if (this.buf.length < 1) return false;
		const type = this.buf[0];
		switch (type) {
			case SMSG_FB_UPDATE: {
				// type(1) pad(1) nrects(2)
				if (this.buf.length < 4) return false;
				this._rectsRemaining = this.buf.readUInt16BE(2);
				this._take(4);
				this.state = "fbUpdate";
				return true;
			}
			case SMSG_BELL: {
				this._take(1);
				this.emit("bell");
				return true;
			}
			case SMSG_SET_COLOUR_MAP: {
				// type(1) pad(1) firstColour(2) nColours(2) then nColours*6
				if (this.buf.length < 6) return false;
				const n = this.buf.readUInt16BE(4);
				if (this.buf.length < 6 + n * 6) return false;
				this._take(6 + n * 6); // ignore; we use true colour
				return true;
			}
			case SMSG_CUT_TEXT: {
				// type(1) pad(3) len(4) text
				if (this.buf.length < 8) return false;
				const len = this.buf.readUInt32BE(4);
				if (this.buf.length < 8 + len) return false;
				const text = this.buf.subarray(8, 8 + len).toString("latin1");
				this._take(8 + len);
				this.emit("cuttext", text);
				return true;
			}
			case SMSG_END_CONTINUOUS_UPDATES: {
				// type(1) only — server confirms it will push updates without requests.
				this._take(1);
				this._continuousUpdates = true;
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
				this._take(9 + len);
				// If the server requested a response, echo the fence (minus the
				// request bit) so it knows we're keeping up.
				if (flags & FENCE_REQUEST)
					this._sendFence(flags & ~FENCE_REQUEST, payload);
				return true;
			}
			default:
				throw new Error(`Unknown server message type ${type}`);
		}
	}

	_stepFbUpdate() {
		if (this._rectsRemaining === 0) {
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
		this._take(12);
		this._rect = { x, y, w, h, enc };
		this.state = "rect";
		return true;
	}

	_stepRect() {
		const r = this._rect;
		if (!r) return false;
		switch (r.enc) {
			case ENC_RAW: {
				const size = r.w * r.h * 4;
				if (this.buf.length < size) return false;
				const px = this._take(size);
				if (!px) return false;
				this.emit("rect", {
					x: r.x,
					y: r.y,
					width: r.w,
					height: r.h,
					data: decodeRaw(px, r.w, r.h),
				});
				return this._rectDone();
			}
			case ENC_COPYRECT: {
				if (this.buf.length < 4) return false;
				const src = this._take(4);
				if (!src) return false;
				const srcX = src.readUInt16BE(0);
				const srcY = src.readUInt16BE(2);
				this.emit("rect", {
					x: r.x,
					y: r.y,
					width: r.w,
					height: r.h,
					copy: { srcX, srcY },
				});
				return this._rectDone();
			}
			case ENC_ZRLE: {
				// u32 length, then that many bytes of the persistent zlib stream.
				if (this.buf.length < 4) return false;
				const len = this.buf.readUInt32BE(0);
				if (this.buf.length < 4 + len) return false;
				const comp = this.buf.subarray(4, 4 + len);
				this._take(4 + len);
				this._inflateChunks = [];
				this._inflate.push(comp, Z_SYNC_FLUSH);
				if (this._inflate.err)
					throw new Error(`ZRLE inflate failed: ${this._inflate.msg}`);
				const data =
					this._inflateChunks.length === 1
						? this._inflateChunks[0]
						: Buffer.concat(this._inflateChunks);
				const rgba = decodeZrle(data, r.w, r.h);
				this.emit("rect", {
					x: r.x,
					y: r.y,
					width: r.w,
					height: r.h,
					data: rgba,
				});
				return this._rectDone();
			}
			case ENC_CURSOR: {
				// body: w*h*4 pixels + floor((w+7)/8)*h mask
				const bodyLen = r.w * r.h * 4 + Math.floor((r.w + 7) / 8) * r.h;
				if (this.buf.length < bodyLen) return false;
				const body = this._take(bodyLen);
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
				return this._rectDone();
			}
			case ENC_DESKTOP_SIZE: {
				this.width = r.w;
				this.height = r.h;
				// Re-arm continuous updates for the new screen size.
				if (this._continuousUpdates) this.enableContinuousUpdates(true);
				this.emit("resize", { width: r.w, height: r.h });
				return this._rectDone();
			}
			default:
				throw new Error(`Unsupported encoding ${r.enc} at ${r.x},${r.y}`);
		}
	}

	_rectDone() {
		this._rect = null;
		this._rectsRemaining--;
		this.state = "fbUpdate";
		return true;
	}

	// ---- Input events (client -> server) ----

	/** @param {number} x @param {number} y @param {number} buttonMask bit0=left,bit1=middle,bit2=right,bit3=wheelUp,bit4=wheelDown */
	pointerEvent(x, y, buttonMask) {
		const b = Buffer.alloc(6);
		b[0] = MSG_POINTER_EVENT;
		b[1] = buttonMask & 0xff;
		b.writeUInt16BE(Math.max(0, Math.min(0xffff, x | 0)), 2);
		b.writeUInt16BE(Math.max(0, Math.min(0xffff, y | 0)), 4);
		if (this.socket && !this.socket.destroyed) this.socket?.write(b);
	}

	/** @param {number} keysym X11 keysym @param {boolean} down */
	keyEvent(keysym, down) {
		const b = Buffer.alloc(8);
		b[0] = MSG_KEY_EVENT;
		b[1] = down ? 1 : 0;
		b.writeUInt32BE(keysym >>> 0, 4);
		if (this.socket && !this.socket.destroyed) this.socket?.write(b);
	}

	/** Send clipboard text to the server. @param {string} text */
	cutText(text) {
		const bytes = Buffer.from(text, "latin1");
		const b = Buffer.alloc(8 + bytes.length);
		b[0] = MSG_CLIENT_CUT_TEXT;
		b.writeUInt32BE(bytes.length, 4);
		bytes.copy(b, 8);
		if (this.socket && !this.socket.destroyed) this.socket?.write(b);
	}
}

/**
 * VNC Authentication: DES-encrypt the 16-byte challenge with the password as the
 * key. Each key byte's bits are reversed (a quirk of the original VNC code).
 */
/** @param {string} password @param {Buffer} challenge */
function vncEncryptChallenge(password, challenge) {
	const key = Buffer.alloc(8);
	for (let i = 0; i < 8; i++) key[i] = reverseBits(password.charCodeAt(i) || 0);
	const out = Buffer.alloc(16);
	for (let off = 0; off < 16; off += 8) {
		const cipher = crypto.createCipheriv("des-ecb", key, null);
		cipher.setAutoPadding(false);
		const block = Buffer.concat([
			cipher.update(challenge.subarray(off, off + 8)),
			cipher.final(),
		]);
		block.copy(out, off);
	}
	return out;
}

/** @param {number} b */
function reverseBits(b) {
	let r = 0;
	for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
	return r & 0xff;
}

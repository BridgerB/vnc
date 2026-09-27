<script lang="ts">
import { onDestroy } from "svelte";
import { keysymFromEvent } from "$lib/keysym.ts";
import type {
	ConnStatus,
	Settings,
	Stats,
	StatusEvent,
	Target,
} from "$lib/types";

interface Props {
	target: Target;
	settings: Settings;
	onstatus?: (s: StatusEvent) => void;
	onstats?: (s: Stats) => void;
}

let { target, settings, onstatus, onstats }: Props = $props();

let container = $state<HTMLDivElement | null>(null);
let canvas = $state<HTMLCanvasElement | null>(null);
let ws: WebSocket | null = null;
let ctx: CanvasRenderingContext2D | null = null;

let status = $state<ConnStatus>("idle");
let errorMsg = $state("");
let fbWidth = $state(0);
let fbHeight = $state(0);
let desktopName = $state("");
let buttonMask = 0;

// stats
let frameCount = 0;
let byteCount = 0;
let statsTimer: ReturnType<typeof setInterval> | undefined;

// auto-reconnect
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let manualClose = false;

function emitStatus() {
	onstatus?.({
		status,
		error: errorMsg,
		name: desktopName,
		width: fbWidth,
		height: fbHeight,
	});
}

export function connect() {
	disconnect(true);
	manualClose = false;
	status = "connecting";
	errorMsg = "";
	emitStatus();
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const q = new URLSearchParams({
		host: target.host,
		port: String(target.port),
	});
	if (target.password) q.set("password", target.password);
	ws = new WebSocket(`${proto}://${location.host}/vnc?${q}`);
	ws.binaryType = "arraybuffer";

	ws.onopen = () => {
		status = "connected";
		reconnectAttempts = 0;
		startStats();
		emitStatus();
	};
	ws.onmessage = (ev) => {
		if (typeof ev.data === "string") {
			byteCount += ev.data.length;
			handleControl(JSON.parse(ev.data));
		} else {
			byteCount += ev.data.byteLength;
			handleBinary(ev.data);
		}
	};
	ws.onclose = () => {
		stopStats();
		if (status !== "error") status = "closed";
		emitStatus();
		maybeReconnect();
	};
	ws.onerror = () => {
		status = "error";
		if (!errorMsg) errorMsg = "connection error";
		emitStatus();
	};
	document.addEventListener("visibilitychange", onVisibility);
}

// When the tab becomes visible again, pull a full frame to replace whatever we
// dropped while it was hidden.
function onVisibility() {
	if (!document.hidden && needsRefresh) {
		needsRefresh = false;
		refresh();
	}
}

export function disconnect(silent = false) {
	manualClose = true;
	clearTimeout(reconnectTimer);
	stopStats();
	if (typeof document !== "undefined")
		document.removeEventListener("visibilitychange", onVisibility);
	audioCtx?.close().catch(() => {});
	audioCtx = null;
	if (ws) {
		// Drop every handler so a late event (e.g. onerror after close()) from the
		// old socket can't clobber the next connection's state.
		ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
		ws.close();
		ws = null;
	}
	if (!silent) {
		status = "idle";
		emitStatus();
	}
}

function maybeReconnect() {
	if (manualClose || !settings?.autoReconnect) return;
	reconnectAttempts++;
	const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
	status = "connecting";
	errorMsg = `reconnecting in ${Math.round(delay / 1000)}s…`;
	emitStatus();
	reconnectTimer = setTimeout(() => connect(), delay);
}

function startStats() {
	frameCount = 0;
	byteCount = 0;
	stopStats();
	statsTimer = setInterval(() => {
		onstats?.({ fps: frameCount, kbps: Math.round(byteCount / 1024) });
		frameCount = 0;
		byteCount = 0;
	}, 1000);
}
function stopStats() {
	clearInterval(statsTimer);
	statsTimer = undefined;
}

// Control frames from the bridge, as a discriminated union on `type`.
type ControlMsg =
	| { type: "init"; width: number; height: number; name?: string }
	| { type: "resize"; width: number; height: number }
	| { type: "error"; message: string }
	| { type: "frame" }
	| { type: "bell" }
	| { type: "cuttext"; text: string };

function handleControl(msg: ControlMsg) {
	switch (msg.type) {
		case "init":
			fbWidth = msg.width;
			fbHeight = msg.height;
			desktopName = msg.name || "";
			queueMicrotask(() => {
				if (canvas) ctx = canvas.getContext("2d", { alpha: false });
			});
			emitStatus();
			break;
		case "resize":
			fbWidth = msg.width;
			fbHeight = msg.height;
			emitStatus();
			break;
		case "error":
			status = "error";
			errorMsg = msg.message;
			emitStatus();
			break;
		case "frame":
			frameCount++;
			scheduleFlush(); // paint this update's queued rects atomically
			break;
		case "bell":
			beep();
			break;
		case "cuttext":
			if (settings?.clipboardSync && navigator.clipboard?.writeText) {
				navigator.clipboard.writeText(msg.text).catch(() => {});
			}
			break;
	}
}

// Rectangles are queued and painted together in a single requestAnimationFrame
// batch (double buffering). Painting each rect the moment its WebSocket message
// arrives lets the compositor sample a half-drawn frame — that's the tearing.
interface DrawOp {
	img?: ImageData;
	x: number;
	y: number;
	w: number;
	h: number;
	srcX?: number;
	srcY?: number;
}
let pendingOps: DrawOp[] = [];
let rafScheduled = false;
// While the tab is hidden, requestAnimationFrame is paused so flushOps never
// runs — but rects keep arriving. Drop them instead of queuing (each full-screen
// rect is megabytes) and request a fresh full frame when the tab returns.
let needsRefresh = false;

function handleBinary(buf: ArrayBuffer) {
	if (typeof document !== "undefined" && document.hidden) {
		needsRefresh = true;
		return;
	}
	const dv = new DataView(buf);
	const tag = dv.getUint8(0);
	if (tag === 3) return applyCursor(buf, dv);
	const x = dv.getUint16(1);
	const y = dv.getUint16(3);
	const w = dv.getUint16(5);
	const h = dv.getUint16(7);
	if (tag === 1) {
		// Build the ImageData now (a view over this message's buffer); the copy
		// into the canvas happens at flush time. Guard against a truncated frame.
		if (buf.byteLength < 9 + w * h * 4) return;
		const pixels = new Uint8ClampedArray(buf, 9, w * h * 4);
		pendingOps.push({ img: new ImageData(pixels, w, h), x, y, w, h });
	} else if (tag === 2) {
		pendingOps.push({
			x,
			y,
			w,
			h,
			srcX: dv.getUint16(9),
			srcY: dv.getUint16(11),
		});
	}
}

function scheduleFlush() {
	if (rafScheduled) return;
	rafScheduled = true;
	requestAnimationFrame(flushOps);
}

function flushOps() {
	rafScheduled = false;
	if (!ctx && canvas) ctx = canvas.getContext("2d", { alpha: false });
	if (!ctx || !canvas) {
		pendingOps = [];
		return;
	}
	// Apply every queued rectangle in arrival order (CopyRect depends on the
	// prior canvas state, so order must be preserved). The whole batch runs
	// synchronously, so the compositor only sees the finished frame.
	for (const op of pendingOps) {
		if (op.img) ctx.putImageData(op.img, op.x, op.y);
		else
			ctx.drawImage(
				canvas,
				op.srcX ?? 0,
				op.srcY ?? 0,
				op.w,
				op.h,
				op.x,
				op.y,
				op.w,
				op.h,
			);
	}
	pendingOps = [];
}

// ---- Cursor (Cursor pseudo-encoding) ----
let cursorCss = $state("none");
function applyCursor(buf: ArrayBuffer, dv: DataView) {
	const w = dv.getUint16(1);
	const h = dv.getUint16(3);
	const hotX = dv.getUint16(5);
	const hotY = dv.getUint16(7);
	if (!settings?.localCursor) {
		cursorCss = "none";
		return;
	}
	if (!w || !h || buf.byteLength < 9 + w * h * 4) {
		cursorCss = "default";
		return;
	}
	const off = document.createElement("canvas");
	off.width = w;
	off.height = h;
	const octx = off.getContext("2d");
	if (!octx) return;
	octx.putImageData(
		new ImageData(new Uint8ClampedArray(buf, 9, w * h * 4), w, h),
		0,
		0,
	);
	cursorCss = `url(${off.toDataURL("image/png")}) ${hotX} ${hotY}, auto`;
}

// ---- Bell ----
let audioCtx: AudioContext | null = null;
function beep() {
	try {
		audioCtx ||= new (
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext })
				.webkitAudioContext
		)();
		const osc = audioCtx.createOscillator();
		const gain = audioCtx.createGain();
		osc.frequency.value = 880;
		gain.gain.value = 0.05;
		osc.connect(gain).connect(audioCtx.destination);
		osc.start();
		osc.stop(audioCtx.currentTime + 0.12);
	} catch {
		/* ignore */
	}
}

// ---- Input ----
function fbCoords(e: MouseEvent | WheelEvent) {
	if (!canvas) return { x: 0, y: 0 };
	const rect = canvas.getBoundingClientRect();
	return {
		x: Math.max(
			0,
			Math.min(
				fbWidth - 1,
				Math.round((e.clientX - rect.left) * (fbWidth / rect.width)),
			),
		),
		y: Math.max(
			0,
			Math.min(
				fbHeight - 1,
				Math.round((e.clientY - rect.top) * (fbHeight / rect.height)),
			),
		),
	};
}
function sendPointer(e: MouseEvent) {
	if (!connected() || settings?.viewOnly || !canvas) return;
	const { x, y } = fbCoords(e);
	ws?.send(JSON.stringify({ type: "pointer", x, y, buttons: buttonMask }));
}
function onMouseDown(e: MouseEvent) {
	if (settings?.viewOnly) return;
	canvas?.focus();
	buttonMask |= 1 << e.button;
	sendPointer(e);
	e.preventDefault();
}
function onMouseUp(e: MouseEvent) {
	if (settings?.viewOnly) return;
	buttonMask &= ~(1 << e.button);
	sendPointer(e);
	e.preventDefault();
}
function onMouseMove(e: MouseEvent) {
	sendPointer(e);
}
function onWheel(e: WheelEvent) {
	if (!connected() || settings?.viewOnly) return;
	const bit = e.deltaY < 0 ? 3 : 4;
	const { x, y } = fbCoords(e);
	ws?.send(
		JSON.stringify({ type: "pointer", x, y, buttons: buttonMask | (1 << bit) }),
	);
	ws?.send(JSON.stringify({ type: "pointer", x, y, buttons: buttonMask }));
	e.preventDefault();
}
function onKey(e: KeyboardEvent, down: boolean) {
	if (!connected() || settings?.viewOnly) return;
	const keysym = keysymFromEvent(e);
	if (!keysym) return;
	ws?.send(JSON.stringify({ type: "key", keysym, down }));
	e.preventDefault();
}

const connected = () => ws && status === "connected";

// ---- Public control API (implements Viewer; used by the toolbar) ----
/** Press a set of keysyms together, then release in reverse order. */
export function sendKeys(keysyms: number[]) {
	if (!connected()) return;
	for (const k of keysyms)
		ws?.send(JSON.stringify({ type: "key", keysym: k, down: true }));
	for (const k of [...keysyms].reverse())
		ws?.send(JSON.stringify({ type: "key", keysym: k, down: false }));
}
export function sendCtrlAltDel() {
	sendKeys([0xffe3, 0xffe9, 0xffff]); // Control_L, Alt_L, Delete
}
/** Read the local clipboard and send it to the server. */
export async function pasteClipboard() {
	if (!connected() || !navigator.clipboard?.readText) return;
	try {
		const text = await navigator.clipboard.readText();
		if (text) ws?.send(JSON.stringify({ type: "cuttext", text }));
	} catch {
		/* permission denied */
	}
}
export function refresh() {
	if (connected()) ws?.send(JSON.stringify({ type: "refresh" }));
}
export function screenshot() {
	if (!canvas) return;
	canvas.toBlob((blob) => {
		if (!blob) return;
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${desktopName || "vnc"}-${Date.now()}.png`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	});
}
export function toggleFullscreen() {
	if (document.fullscreenElement) document.exitFullscreen();
	else container?.requestFullscreen?.();
}
/** Downscaled snapshot of the current framebuffer for card previews. */
export function thumbnail(w = 720): string | null {
	if (!canvas || !fbWidth) return null;
	try {
		const off = document.createElement("canvas");
		off.width = w;
		off.height = Math.round((fbHeight / fbWidth) * w);
		const octx = off.getContext("2d");
		if (!octx) return null;
		octx.imageSmoothingEnabled = true;
		octx.imageSmoothingQuality = "high";
		octx.drawImage(canvas, 0, 0, off.width, off.height);
		return off.toDataURL("image/jpeg", 0.9);
	} catch {
		return null;
	}
}

onDestroy(() => disconnect());
</script>

<div
	class="screen {settings?.scaleMode}"
	class:viewonly={settings?.viewOnly}
	bind:this={container}
>
	{#if fbWidth}
		<canvas
			bind:this={canvas}
			width={fbWidth}
			height={fbHeight}
			tabindex="0"
			style:cursor={cursorCss}
			onmousedown={onMouseDown}
			onmouseup={onMouseUp}
			onmousemove={onMouseMove}
			onwheel={onWheel}
			onkeydown={(e) => onKey(e, true)}
			onkeyup={(e) => onKey(e, false)}
			oncontextmenu={(e) => e.preventDefault()}
		></canvas>
	{/if}
</div>

<style>
	.screen {
		position: relative;
		width: 100%;
		height: 100%;
		background: var(--void, #0a0c0f);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.screen.actual {
		align-items: flex-start;
		justify-content: flex-start;
		overflow: auto;
	}
	canvas {
		outline: none;
		display: block;
	}
	.screen.fit canvas {
		max-width: 100%;
		max-height: 100%;
		width: auto;
		height: auto;
		object-fit: contain;
	}
	.screen.stretch canvas {
		width: 100%;
		height: 100%;
		object-fit: fill;
	}
	.screen.viewonly canvas {
		cursor: default !important;
	}
</style>

<script lang="ts">
import { onDestroy } from "svelte";
import { KEYCODES } from "$lib/stream/keycodes.js";
import type {
	ConnStatus,
	Settings,
	Stats,
	StatusEvent,
	Target,
} from "$lib/types";

/**
 * Low-latency H.264 stream viewer (WebCodecs decode + absolute uinput input).
 * Implements the Viewer surface so Session can drive it interchangeably with
 * VncViewer.
 */
interface Props {
	target: Target;
	settings: Settings;
	onstatus?: (s: StatusEvent) => void;
	onstats?: (s: Stats) => void;
}

let { target, settings, onstatus, onstats }: Props = $props();

let container = $state<HTMLDivElement | null>(null);
let canvas = $state<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let ws: WebSocket | null = null;
let decoder: VideoDecoder | null = null;
let status = $state<ConnStatus>("idle");
let errorMsg = $state("");
let fbW = $state(0);
let fbH = $state(0);
let pending: VideoFrame | null = null;
let rafId = 0;
let waitingKey = true;
let ts = 0;
let frameBytes = 0;
let frameCount = 0;
let statTimer: ReturnType<typeof setInterval> | undefined;

// auto-reconnect (parity with VncViewer)
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let manualClose = false;

function emit() {
	onstatus?.({
		status,
		error: errorMsg,
		name: target.host,
		width: fbW,
		height: fbH,
	});
}

export function connect() {
	disconnect(true);
	manualClose = false;
	if (!("VideoDecoder" in window)) {
		status = "error";
		errorMsg = "This browser has no WebCodecs support";
		emit();
		return;
	}
	status = "connecting";
	errorMsg = "";
	emit();
	const proto = location.protocol === "https:" ? "wss" : "ws";
	ws = new WebSocket(`${proto}://${target.host}:${target.port}`);
	ws.binaryType = "arraybuffer";
	ws.onopen = () => {
		status = "connected";
		reconnectAttempts = 0;
		emit();
	};
	ws.onerror = () => {
		status = "error";
		if (!errorMsg) errorMsg = "connection error";
		emit();
	};
	ws.onclose = () => {
		if (status !== "error") status = "closed";
		emit();
		maybeReconnect();
	};
	ws.onmessage = (ev) => handleFrame(ev.data);

	// paint newest decoded frame at display refresh (decode decoupled from paint).
	// Acquire the context lazily: the canvas only mounts once the first frame
	// sets fbW, so it doesn't exist yet when connect() runs.
	const paintLoop = () => {
		if (!ctx && canvas)
			ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
		if (pending && ctx) {
			ctx.drawImage(pending, 0, 0);
			pending.close();
			pending = null;
		}
		rafId = requestAnimationFrame(paintLoop);
	};
	rafId = requestAnimationFrame(paintLoop);

	statTimer = setInterval(() => {
		onstats?.({ fps: frameCount, kbps: Math.round(frameBytes / 1024) });
		frameCount = 0;
		frameBytes = 0;
	}, 1000);
}

export function disconnect(silent = false) {
	manualClose = true;
	clearTimeout(reconnectTimer);
	clearInterval(statTimer);
	cancelAnimationFrame(rafId);
	pending?.close();
	pending = null;
	if (ws) {
		// Drop every handler so a late event from the old socket can't clobber
		// the next connection's state.
		ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
		ws.close();
		ws = null;
	}
	resetDecoder();
	waitingKey = true;
	ts = 0;
	if (!silent) {
		status = "idle";
		emit();
	}
}

function resetDecoder() {
	try {
		decoder?.close();
	} catch {
		/* already closed */
	}
	decoder = null;
}

function maybeReconnect() {
	if (manualClose || !settings?.autoReconnect) return;
	reconnectAttempts++;
	const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
	status = "connecting";
	errorMsg = `reconnecting in ${Math.round(delay / 1000)}s…`;
	emit();
	reconnectTimer = setTimeout(() => connect(), delay);
}

const hex2 = (b: number) => b.toString(16).padStart(2, "0");
function findNal(au: Uint8Array, type: number) {
	for (let i = 0; i + 3 < au.length; i++) {
		if (
			au[i] === 0 &&
			au[i + 1] === 0 &&
			au[i + 2] === 1 &&
			(au[i + 3] & 0x1f) === type
		)
			return au.subarray(i + 3);
	}
	return null;
}

function handleFrame(data: ArrayBuffer) {
	const buf = new Uint8Array(data);
	frameBytes += buf.length;
	const keyframe = buf[0] === 1;
	const au = buf.subarray(5); // [u8 keyframe][u32 ts] header
	frameCount++;

	if (!decoder) {
		if (!keyframe) return;
		const sps = findNal(au, 7);
		const codec = sps
			? `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`
			: "avc1.4d0033";
		decoder = new VideoDecoder({
			output: (frame) => {
				if (fbW !== frame.displayWidth) {
					if (canvas) {
						canvas.width = frame.displayWidth;
						canvas.height = frame.displayHeight;
					}
					fbW = frame.displayWidth;
					fbH = frame.displayHeight;
					emit();
				}
				if (pending) pending.close();
				pending = frame;
			},
			// On a decode error the decoder is dead; tear it down and wait for the
			// next keyframe to rebuild it, so the stream recovers instead of
			// silently freezing.
			error: () => {
				resetDecoder();
				waitingKey = true;
			},
		});
		try {
			decoder.configure({
				codec,
				optimizeForLatency: true,
				hardwareAcceleration: "prefer-hardware",
			});
		} catch {
			resetDecoder();
			status = "error";
			errorMsg = `cannot decode ${codec}`;
			emit();
			return;
		}
		waitingKey = false;
	}
	if (waitingKey && !keyframe) return;
	if (!decoder) return;
	waitingKey = false;
	try {
		decoder.decode(
			new EncodedVideoChunk({
				type: keyframe ? "key" : "delta",
				timestamp: ts,
				data: au,
			}),
		);
		ts += 1e6 / 60;
	} catch {
		/* decoder not ready */
	}
}

// ---- input (absolute + native cursor = instant) ----
// Input messages sent to the stream server (mirror of its InputMsg union).
type OutMsg =
	| { t: "a"; x: number; y: number }
	| { t: "btn"; b: number; down: boolean }
	| { t: "wheel"; dy: number; dx: number }
	| { t: "key"; code: number; down: boolean };

const send = (o: OutMsg) => {
	if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
};
const btnOf = (e: MouseEvent) => (e.button === 1 ? 2 : e.button === 2 ? 1 : 0);
function absFromEvent(e: MouseEvent) {
	if (!canvas) return { x: 0, y: 0 };
	const r = canvas.getBoundingClientRect();
	const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
	const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
	return { x: Math.round(x * 65535), y: Math.round(y * 65535) };
}
function onMove(e: MouseEvent) {
	if (settings?.viewOnly) return;
	const { x, y } = absFromEvent(e);
	send({ t: "a", x, y });
}
function onDown(e: MouseEvent) {
	if (settings?.viewOnly) return;
	canvas?.focus();
	const { x, y } = absFromEvent(e);
	send({ t: "a", x, y });
	send({ t: "btn", b: btnOf(e), down: true });
	e.preventDefault();
}
function onUp(e: MouseEvent) {
	if (settings?.viewOnly) return;
	send({ t: "btn", b: btnOf(e), down: false });
	e.preventDefault();
}
function onWheel(e: WheelEvent) {
	if (settings?.viewOnly) return;
	send({
		t: "wheel",
		dy: e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0,
		dx: e.deltaX > 0 ? 1 : e.deltaX < 0 ? -1 : 0,
	});
	e.preventDefault();
}
function onKey(e: KeyboardEvent, down: boolean) {
	if (settings?.viewOnly) return;
	if (document.activeElement !== canvas) return;
	if (down && e.repeat) return;
	const code = KEYCODES[e.code];
	if (code === undefined) return;
	send({ t: "key", code, down });
	e.preventDefault();
}

// ---- public API (implements Viewer) ----
export function sendKeys(_keysyms: number[]) {
	/* stream uses evdev codes, not X keysyms; toolbar special-keys are VNC-only */
}
export function sendCtrlAltDel() {
	for (const c of [29, 56, 111]) send({ t: "key", code: c, down: true }); // LEFTCTRL, LEFTALT, DELETE
	for (const c of [111, 56, 29]) send({ t: "key", code: c, down: false });
}
export function pasteClipboard() {
	/* not wired for stream yet */
}
export function refresh() {
	/* keyframes are periodic; no-op */
}
export function screenshot() {
	canvas?.toBlob((blob) => {
		if (!blob) return;
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `stream-${Date.now()}.png`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	});
}
export function toggleFullscreen() {
	if (document.fullscreenElement) document.exitFullscreen();
	else container?.requestFullscreen?.();
}
export function thumbnail(w = 360): string | null {
	if (!canvas || !fbW) return null;
	try {
		const off = document.createElement("canvas");
		off.width = w;
		off.height = Math.round((fbH / fbW) * w);
		const octx = off.getContext("2d");
		if (!octx) return null;
		octx.drawImage(canvas, 0, 0, off.width, off.height);
		return off.toDataURL("image/jpeg", 0.6);
	} catch {
		return null;
	}
}

onDestroy(disconnect);
</script>

<svelte:window onkeydown={(e) => onKey(e, true)} onkeyup={(e) => onKey(e, false)} />

<div class="screen {settings?.scaleMode}" class:viewonly={settings?.viewOnly} bind:this={container}>
	{#if fbW}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<canvas
			bind:this={canvas}
			tabindex="0"
			width={fbW}
			height={fbH}
			onmousedown={onDown}
			onmouseup={onUp}
			onmousemove={onMove}
			onwheel={onWheel}
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
</style>

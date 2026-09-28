<script lang="ts">
import { onDestroy, onMount, untrack } from "svelte";
import StreamViewer from "$lib/StreamViewer.svelte";
import type {
	ConnectedInfo,
	ConnStatus,
	Settings,
	Stats,
	StatusEvent,
	Target,
	Viewer,
} from "$lib/types";
import Icon from "$lib/ui/Icon.svelte";
import VncViewer from "$lib/VncViewer.svelte";
import KeysPopover from "./KeysPopover.svelte";
import SettingsPanel from "./SettingsPanel.svelte";

interface Props {
	target: Target;
	settings: Settings;
	label?: string;
	onexit: () => void;
	onconnected?: (info: ConnectedInfo) => void;
	onthumbnail?: (dataUrl: string) => void;
}

let {
	target,
	settings = $bindable(),
	label,
	onexit,
	onconnected,
	onthumbnail,
}: Props = $props();

let viewer = $state<Viewer>();
let status = $state<ConnStatus>("connecting");
let errorMsg = $state("");
let name = $state(untrack(() => label || target.host));
let dim = $state("");
let stats = $state<Stats>({ fps: 0, kbps: 0 });

let panelOpen = $state(false);
let keysOpen = $state(false);
let toolbarVisible = $state(true);
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let barHover = $state(false);

const host = $derived(`${target.host}:${target.port}`);
const reconnecting = $derived(
	status === "connecting" && errorMsg.startsWith("reconnect"),
);
const connecting = $derived(status === "connecting" && !reconnecting);
const mbps = $derived((stats.kbps / 1024).toFixed(1));

onMount(() => {
	viewer?.connect();
});
onDestroy(() => clearTimeout(hideTimer));

function onstatus(s: StatusEvent) {
	const was = status;
	status = s.status;
	errorMsg = s.error || "";
	if (s.name) name = s.name;
	if (s.width) dim = `${s.width}×${s.height}`;
	if (s.status === "connected" && was !== "connected") {
		onconnected?.({ width: s.width || 0, height: s.height || 0 });
	}
}

function showToolbar() {
	toolbarVisible = true;
	clearTimeout(hideTimer);
	hideTimer = setTimeout(() => {
		if (!panelOpen && !keysOpen && !barHover) toolbarVisible = false;
	}, 2500);
}

function disconnect() {
	const t = viewer?.thumbnail();
	if (t) onthumbnail?.(t);
	viewer?.disconnect();
	onexit();
}
function retry() {
	errorMsg = "";
	status = "connecting";
	viewer?.connect();
}
function sendKeys(k: number[]) {
	viewer?.sendKeys(k);
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		if (keysOpen) keysOpen = false;
		else if (panelOpen) panelOpen = false;
		else showToolbar();
	}
}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="session" onpointermove={showToolbar} role="application">
	{#if target.kind === "stream"}
		<StreamViewer bind:this={viewer} {target} {settings} {onstatus} onstats={(s) => (stats = s)} />
	{:else}
		<VncViewer bind:this={viewer} {target} {settings} {onstatus} onstats={(s) => (stats = s)} />
	{/if}
	<div class="vignette"></div>

	<!-- top-left security pill -->
	<div class="pill tl" class:hidden={!toolbarVisible}>
		<Icon name="shield" size={14} class="ok" />
		Encrypted · {settings.scaleMode === "fit" ? "scaled to fit" : settings.scaleMode === "actual" ? "1:1" : "stretched"}
	</div>

	<!-- top-right stats HUD -->
	{#if settings.showStats && status === "connected"}
		<div class="hud mono" class:hidden={!toolbarVisible}>
			<span><span class="k">fps</span> {stats.fps}</span>
			<span><span class="k">bw</span> {mbps} MB/s</span>
			<span><span class="k">res</span> {dim || "—"}</span>
		</div>
	{/if}

	<!-- floating toolbar -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="toolbar"
		class:hidden={!toolbarVisible}
		onpointerenter={() => (barHover = true)}
		onpointerleave={() => (barHover = false)}
	>
		<div class="ident">
			<span class="dot" class:online={status === "connected"} class:warn={reconnecting} class:error={status === "error"}></span>
			<span class="name">{name}</span>
			<span class="mono host">{host}</span>
		</div>
		<button class="tbtn" onclick={() => viewer?.toggleFullscreen()}><Icon name="full" /><span>Fullscreen</span></button>
		<button class="tbtn" onclick={() => viewer?.sendCtrlAltDel()}><Icon name="key" /><span>Ctrl+Alt+Del</span></button>
		<div class="anchor">
			<button class="tbtn icon" class:on={keysOpen} onclick={() => (keysOpen = !keysOpen)} aria-label="Send keys"><Icon name="grid" /></button>
			{#if keysOpen}
				<div class="popwrap">
					<KeysPopover onsend={sendKeys} onclose={() => (keysOpen = false)} />
				</div>
			{/if}
		</div>
		<button class="tbtn" onclick={() => viewer?.pasteClipboard()}><Icon name="clip" /><span>Clipboard</span></button>
		<button class="tbtn icon" onclick={() => viewer?.screenshot()} aria-label="Capture"><Icon name="cam" /></button>
		<button class="tbtn icon" class:on={panelOpen} onclick={() => (panelOpen = !panelOpen)} aria-label="Settings"><Icon name="cog" /></button>
		<button class="tbtn danger" onclick={disconnect}><Icon name="power" /><span>Disconnect</span></button>
	</div>

	{#if panelOpen}
		<SettingsPanel bind:settings {name} host={target.host} {stats} onclose={() => (panelOpen = false)} />
	{/if}

	<!-- connection state overlays -->
	{#if connecting}
		<div class="overlay">
			<div class="statecard">
				<div class="eyebrow">Connecting</div>
				<div class="chead">
					<span class="cicon accent"><Icon name="mon" size={19} /></span>
					<div><div class="ctitle">{name}</div><div class="mono csub">{host}</div></div>
				</div>
				<div class="bar-progress"><span></span></div>
				<div class="phase">Establishing session — RFB handshake &amp; first framebuffer</div>
				<div class="cactions"><button class="btn" onclick={disconnect}>Cancel</button><span class="mono tip">Esc cancels</span></div>
			</div>
		</div>
	{:else if reconnecting}
		<div class="overlay">
			<div class="statecard warn">
				<div class="eyebrow warn-t">Reconnecting</div>
				<div class="chead">
					<span class="cicon warn-i"><Icon name="refresh" size={19} /></span>
					<div><div class="ctitle">Link dropped — retrying</div><div class="mono csub">{name} · {host}</div></div>
				</div>
				<div class="note warn-note">{errorMsg}. Session state is preserved — clipboard, scaling and view-only survive.</div>
				<div class="cactions"><button class="btn" onclick={retry}>Retry now</button><button class="btn btn-ghost" onclick={disconnect}>Give up</button></div>
			</div>
		</div>
	{:else if status === "error" || status === "closed"}
		<div class="overlay">
			<div class="statecard error">
				<div class="eyebrow err-t">{status === "error" ? "Connection failed" : "Disconnected"}</div>
				<div class="chead">
					<span class="cicon err-i"><Icon name="alert" size={19} /></span>
					<div><div class="ctitle">{status === "error" ? "Could not connect" : "Session ended"}</div><div class="mono csub">{name} · {host}</div></div>
				</div>
				{#if errorMsg}<div class="errbox mono">{errorMsg}</div>{/if}
				<div class="cactions"><button class="btn-primary btn" onclick={retry}><Icon name="refresh" size={15} />Retry</button><button class="btn" onclick={onexit}>Back to machines</button></div>
			</div>
		</div>
	{/if}
</div>

<style>
	.session {
		position: fixed;
		inset: 0;
		background: var(--void);
		overflow: hidden;
	}
	.vignette {
		position: absolute;
		inset: 0;
		pointer-events: none;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05), inset 0 -120px 120px -90px rgba(7, 9, 15, 0.7);
	}
	.hidden {
		opacity: 0;
		pointer-events: none;
		transform: translateY(12px);
	}
	.pill,
	.hud,
	.toolbar {
		transition: opacity 0.18s ease, transform 0.18s ease;
	}

	.pill {
		position: absolute;
		top: 22px;
		left: 22px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 11px;
		border-radius: 999px;
		background: rgba(23, 27, 33, 0.72);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
		font: 500 11px/1 var(--sans);
		color: var(--muted);
	}
	.pill :global(.ok) {
		color: var(--online);
	}

	.hud {
		position: absolute;
		top: 22px;
		right: 22px;
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 9px 13px;
		border-radius: 12px;
		background: rgba(23, 27, 33, 0.72);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
		font-size: 11.5px;
		color: var(--ink-2);
	}
	.hud .k {
		color: var(--faint);
	}

	.toolbar {
		position: absolute;
		left: 50%;
		bottom: 26px;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 7px 8px;
		border-radius: 15px;
		background: rgba(23, 27, 33, 0.82);
		backdrop-filter: blur(20px) saturate(1.3);
		-webkit-backdrop-filter: blur(20px) saturate(1.3);
		box-shadow: var(--shadow-float);
		color: var(--ink);
		z-index: 30;
	}
	.toolbar.hidden {
		transform: translateX(-50%) translateY(12px);
	}
	.ident {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 0 13px 0 9px;
		margin-right: 4px;
		border-right: 1px solid var(--line-2);
	}
	.ident .name {
		font: 600 12.5px/1 var(--sans);
		white-space: nowrap;
	}
	.ident .host {
		font-size: 11.5px;
		color: var(--muted);
	}
	.tbtn {
		height: 34px;
		padding: 0 11px;
		border: none;
		border-radius: var(--r);
		background: none;
		color: var(--ink-2);
		display: flex;
		align-items: center;
		gap: 7px;
		font: 500 12px/1 var(--sans);
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.tbtn:hover {
		background: var(--fill);
		color: var(--ink);
	}
	.tbtn.icon {
		width: 34px;
		padding: 0;
		justify-content: center;
	}
	.tbtn.on {
		background: var(--accent-wash-2);
		box-shadow: inset 0 0 0 1px rgba(255, 106, 61, 0.55);
		color: var(--accent-tint);
	}
	.tbtn.danger {
		margin-left: 4px;
		padding: 0 13px;
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 700;
		box-shadow: 0 6px 16px rgba(255, 106, 61, 0.4);
	}
	.tbtn.danger:hover {
		background: var(--accent-soft);
	}
	.anchor {
		position: relative;
		display: flex;
	}
	.popwrap {
		position: absolute;
		bottom: calc(100% + 12px);
		left: 50%;
		transform: translateX(-50%);
	}

	/* state overlays */
	.overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(7, 9, 15, 0.55);
		backdrop-filter: blur(3px);
		-webkit-backdrop-filter: blur(3px);
		z-index: 50;
	}
	.statecard {
		width: 420px;
		border-radius: var(--r-xl);
		background: var(--modal);
		border: 1px solid var(--line);
		padding: 26px;
		box-shadow: 0 40px 90px rgba(0, 0, 0, 0.6);
		display: flex;
		flex-direction: column;
	}
	.statecard.warn {
		border-color: rgba(251, 191, 36, 0.3);
	}
	.statecard.error {
		border-color: rgba(244, 63, 94, 0.28);
	}
	.eyebrow {
		margin-bottom: 20px;
	}
	.eyebrow.warn-t {
		color: var(--warn);
	}
	.eyebrow.err-t {
		color: var(--error);
	}
	.chead {
		display: flex;
		align-items: center;
		gap: 13px;
		margin-bottom: 20px;
	}
	.cicon {
		width: 38px;
		height: 38px;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.cicon.accent {
		background: var(--accent-wash);
		color: var(--accent-soft);
	}
	.cicon.warn-i {
		background: var(--warn-wash);
		color: var(--warn);
	}
	.cicon.err-i {
		background: var(--error-wash);
		color: var(--error);
	}
	.ctitle {
		font: 700 15px/1.1 var(--sans);
	}
	.csub {
		font-size: 12px;
		color: var(--muted);
		margin-top: 6px;
	}
	.bar-progress {
		height: 4px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		overflow: hidden;
		margin-bottom: 16px;
	}
	.bar-progress span {
		display: block;
		height: 100%;
		width: 40%;
		border-radius: 999px;
		background: linear-gradient(90deg, var(--accent-press), var(--accent-soft));
		animation: indet 1.3s ease-in-out infinite;
	}
	@keyframes indet {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(320%);
		}
	}
	.phase {
		font: 400 12.5px/1.5 var(--sans);
		color: var(--muted);
		margin-bottom: 22px;
	}
	.note {
		padding: 12px 14px;
		border-radius: var(--r-md);
		font: 400 11.5px/1.5 var(--sans);
		margin-bottom: 20px;
	}
	.warn-note {
		background: rgba(251, 191, 36, 0.08);
		border: 1px solid rgba(251, 191, 36, 0.22);
		color: var(--warn-soft);
	}
	.errbox {
		padding: 13px 15px;
		border-radius: var(--r-md);
		background: var(--void);
		border: 1px solid var(--line);
		font-size: 11.5px;
		line-height: 1.6;
		color: var(--error);
		margin-bottom: 20px;
		word-break: break-word;
	}
	.cactions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: auto;
	}
	.tip {
		font-size: 11.5px;
		color: var(--faint);
	}
</style>

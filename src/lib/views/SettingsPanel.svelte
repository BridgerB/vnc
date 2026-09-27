<script lang="ts">
import type { ScaleMode, Settings, Stats } from "$lib/types";
import Icon from "$lib/ui/Icon.svelte";

interface Props {
	settings: Settings;
	name?: string;
	host?: string;
	stats: Stats;
	onclose: () => void;
}

let { settings = $bindable(), name, host, stats, onclose }: Props = $props();

const scaleModes: { id: ScaleMode; label: string }[] = [
	{ id: "fit", label: "Fit to window" },
	{ id: "actual", label: "1:1 pixels" },
	{ id: "stretch", label: "Stretch" },
];

const mbps = $derived((stats.kbps / 1024).toFixed(1));
</script>

<aside class="panel">
	<header>
		<div>
			<div class="title">Session settings</div>
			<div class="sub mono">{name || "—"} · {host || ""}</div>
		</div>
		<button class="iconbtn" onclick={onclose} aria-label="Close settings"><Icon name="x" size={15} /></button>
	</header>

	<section>
		<div class="eyebrow">Display</div>
		<div class="segmented">
			{#each scaleModes as m}
				<button class:on={settings.scaleMode === m.id} onclick={() => (settings.scaleMode = m.id)}>
					{m.label}
				</button>
			{/each}
		</div>
		<div class="row" style="margin-top:14px">
			<div class="row-l"><Icon name="eye" size={16} /><span>View only</span></div>
			<button
				class="toggle" role="switch"
				aria-checked={settings.viewOnly}
				aria-label="View only"
				onclick={() => (settings.viewOnly = !settings.viewOnly)}
			></button>
		</div>
		<div class="hint">Input is dropped locally; the framebuffer keeps updating.</div>
	</section>

	<section>
		<div class="eyebrow">Quality</div>
		<div class="slider-head"><span>Image quality</span><span class="mono val">{settings.quality} / 9</span></div>
		<input
			class="slider"
			type="range"
			min="0"
			max="9"
			bind:value={settings.quality}
			style="--pct:{(settings.quality / 9) * 100}%"
		/>
		<div class="scale mono"><span>fast</span><span>≈ {mbps} MB/s at {stats.fps} fps</span><span>sharp</span></div>

		<div class="slider-head" style="margin-top:16px">
			<span>Compression</span><span class="mono val">{settings.compression} / 9</span>
		</div>
		<input
			class="slider"
			type="range"
			min="0"
			max="9"
			bind:value={settings.compression}
			style="--pct:{(settings.compression / 9) * 100}%"
		/>
		<div class="scale mono"><span>low cpu</span><span>low bandwidth</span></div>
	</section>

	<section>
		<div class="eyebrow">Encoding</div>
		<div class="select">
			<span class="mono">ZRLE</span>
			<span class="tag lab">active</span>
			<Icon name="chev" size={15} class="chev" />
		</div>
		<div class="hint">Also negotiated: CopyRect, Raw. Server advertises ZRLE, Tight.</div>
	</section>

	<section class="toggles">
		<div class="row">
			<div>
				<div class="row-title">Auto-reconnect</div>
				<div class="hint">Retry with exponential backoff</div>
			</div>
			<button
				class="toggle" role="switch"
				aria-checked={settings.autoReconnect}
				aria-label="Auto-reconnect"
				onclick={() => (settings.autoReconnect = !settings.autoReconnect)}
			></button>
		</div>
		<div class="row">
			<div>
				<div class="row-title">Clipboard sync</div>
				<div class="hint">Bidirectional, text only</div>
			</div>
			<button
				class="toggle" role="switch"
				aria-checked={settings.clipboardSync}
				aria-label="Clipboard sync"
				onclick={() => (settings.clipboardSync = !settings.clipboardSync)}
			></button>
		</div>
		<div class="row">
			<div>
				<div class="row-title">Local cursor</div>
				<div class="hint">Draw the remote cursor shape client-side</div>
			</div>
			<button
				class="toggle" role="switch"
				aria-checked={settings.localCursor}
				aria-label="Local cursor"
				onclick={() => (settings.localCursor = !settings.localCursor)}
			></button>
		</div>
	</section>

	<div class="live">Changes apply live. <span>Saved to this machine's profile on disconnect.</span></div>
</aside>

<style>
	.panel {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: 400px;
		background: rgba(20, 24, 30, 0.94);
		backdrop-filter: blur(24px);
		-webkit-backdrop-filter: blur(24px);
		box-shadow: -1px 0 0 rgba(255, 255, 255, 0.08), -30px 0 60px rgba(0, 0, 0, 0.5);
		padding: 22px;
		display: flex;
		flex-direction: column;
		gap: 22px;
		overflow-y: auto;
		z-index: 40;
		animation: slidein 0.22s ease;
	}
	@keyframes slidein {
		from {
			transform: translateX(24px);
			opacity: 0;
		}
	}
	header {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}
	.title {
		font: 700 16px/1.1 var(--sans);
		letter-spacing: -0.01em;
	}
	.sub {
		font-size: 11.5px;
		color: var(--muted);
		margin-top: 6px;
	}
	.iconbtn {
		margin-left: auto;
		width: 30px;
		height: 30px;
		border-radius: 9px;
		background: var(--fill);
		border: none;
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.iconbtn:hover {
		background: var(--fill-2);
		color: var(--ink);
	}
	section {
		display: flex;
		flex-direction: column;
	}
	.eyebrow {
		margin-bottom: 11px;
	}
	.segmented {
		display: flex;
		gap: 3px;
		padding: 3px;
		border-radius: var(--r-md);
		background: rgba(255, 255, 255, 0.05);
	}
	.segmented button {
		flex: 1;
		height: 32px;
		border: none;
		border-radius: 9px;
		background: none;
		color: var(--muted);
		font: 500 12px/1 var(--sans);
		cursor: pointer;
	}
	.segmented button.on {
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 700;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.row-l {
		display: flex;
		align-items: center;
		gap: 9px;
		color: var(--muted);
		font: 500 13px/1 var(--sans);
	}
	.row-title {
		font: 500 13px/1 var(--sans);
	}
	.toggles {
		gap: 15px;
	}
	.toggles .row {
		margin-bottom: 0;
	}
	.hint {
		font: 400 11.5px/1.45 var(--sans);
		color: var(--faint);
		margin-top: 7px;
	}
	.slider-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 9px;
		font: 500 13px/1 var(--sans);
	}
	.val {
		color: var(--accent-soft);
		font-size: 12px;
	}
	.slider {
		-webkit-appearance: none;
		appearance: none;
		width: 100%;
		height: 5px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--accent) 0 var(--pct),
			rgba(255, 255, 255, 0.09) var(--pct) 100%
		);
		outline: none;
		margin: 0 0 6px;
	}
	.slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 0 0 4px rgba(255, 106, 61, 0.25), 0 2px 6px rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.slider::-moz-range-thumb {
		width: 15px;
		height: 15px;
		border: none;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 0 0 4px rgba(255, 106, 61, 0.25);
		cursor: pointer;
	}
	.scale {
		display: flex;
		justify-content: space-between;
		font-size: 10.5px;
		color: var(--faint);
	}
	.select {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 40px;
		padding: 0 13px;
		border-radius: var(--r-md);
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--line-2);
		font-size: 13px;
	}
	.select :global(.chev) {
		margin-left: auto;
		color: var(--muted);
		transform: rotate(90deg);
	}
	.live {
		margin-top: auto;
		padding: 13px 15px;
		border-radius: var(--r-md);
		background: rgba(255, 106, 61, 0.1);
		border: 1px solid rgba(255, 106, 61, 0.28);
		font: 400 11.5px/1.5 var(--sans);
		color: var(--accent-tint);
	}
	.live span {
		color: var(--muted);
	}
</style>

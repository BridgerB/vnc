<script lang="ts">
import Icon from "$lib/ui/Icon.svelte";

interface Props {
	onsend: (keysyms: number[]) => void;
	onclose: () => void;
}

let { onsend, onclose }: Props = $props();

const CTRL = 0xffe3,
	ALT = 0xffe9,
	SHIFT = 0xffe1,
	SUPER = 0xffe7;

const modifiers = [
	{ sym: CTRL, label: "⌃ Ctrl" },
	{ sym: ALT, label: "⌥ Alt" },
	{ sym: SHIFT, label: "⇧ Shift" },
	{ sym: SUPER, label: "◆ Super" },
];
const macros = [
	{ label: "Ctrl + Alt + Del", note: "⌃⌥⌦", keys: [CTRL, ALT, 0xffff] },
	{ label: "Alt + Tab", note: "switch", keys: [ALT, 0xff09] },
	{ label: "Ctrl + Alt + F2", note: "tty switch", keys: [CTRL, ALT, 0xffbf] },
	{ label: "Print Screen", note: "remote", keys: [0xff61] },
];

let latched = $state(new Set<number>());

function toggleMod(sym: number) {
	const next = new Set(latched);
	if (next.has(sym)) next.delete(sym);
	else next.add(sym);
	latched = next;
}
function fnKey(i: number) {
	const sym = 0xffbe + i; // F1..F12
	onsend([...latched, sym]);
	latched = new Set();
}
function macro(keys: number[]) {
	onsend(keys);
	onclose();
}
</script>

<div class="pop">
	<div class="head">
		<Icon name="key" size={16} class="accent" />
		<span class="ttl">Send keys</span>
		<span class="mono muted">modifiers latch</span>
	</div>

	<div class="eyebrow">Modifiers · latch</div>
	<div class="mods">
		{#each modifiers as m}
			<button class="mod mono" class:on={latched.has(m.sym)} onclick={() => toggleMod(m.sym)}>{m.label}</button>
		{/each}
	</div>

	<div class="eyebrow">Macros</div>
	<div class="macros">
		{#each macros as m}
			<button class="macro" onclick={() => macro(m.keys)}>
				<span class="dot on"></span>{m.label}<span class="note mono">{m.note}</span>
			</button>
		{/each}
	</div>

	<div class="eyebrow">Function keys</div>
	<div class="fkeys">
		{#each Array(12) as _, i}
			<button class="fkey mono" onclick={() => fnKey(i)}>F{i + 1}</button>
		{/each}
	</div>

	<div class="foot">
		<span class="mono">
			Pending: {#if latched.size}<span class="accent-tint"
					>{[...latched].map((s) => modifiers.find((m) => m.sym === s)?.label.split(" ")[0]).join(" + ")} + …</span
				>{:else}<span class="muted">none</span>{/if}
		</span>
		<button class="close" onclick={onclose}>Done</button>
	</div>
</div>

<style>
	.pop {
		width: 472px;
		border-radius: var(--r-xl);
		background: rgba(20, 24, 30, 0.94);
		backdrop-filter: blur(24px);
		-webkit-backdrop-filter: blur(24px);
		box-shadow: var(--shadow-pop);
		padding: 18px;
		color: var(--ink);
		animation: rise 0.16s ease;
	}
	@keyframes rise {
		from {
			transform: translateY(8px);
			opacity: 0;
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 9px;
		margin-bottom: 16px;
	}
	.head :global(.accent) {
		color: var(--accent);
	}
	.ttl {
		font: 600 13px/1 var(--sans);
	}
	.muted {
		color: var(--faint);
		font-size: 11px;
	}
	.head .muted {
		margin-left: auto;
	}
	.eyebrow {
		margin-bottom: 10px;
	}
	.mods {
		display: flex;
		gap: 7px;
		margin-bottom: 18px;
	}
	.mod {
		flex: 1;
		height: 38px;
		border: none;
		border-radius: var(--r);
		background: var(--fill);
		color: var(--ink-2);
		font-size: 13px;
		cursor: pointer;
	}
	.mod.on {
		background: var(--accent-wash-2);
		box-shadow: inset 0 0 0 1px rgba(255, 106, 61, 0.55);
		color: var(--accent-tint);
	}
	.macros {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin-bottom: 18px;
	}
	.macro {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 10px 11px;
		border: none;
		border-radius: var(--r);
		background: none;
		color: var(--ink-2);
		font: 500 13px/1 var(--sans);
		cursor: pointer;
		text-align: left;
	}
	.macro:first-child {
		background: var(--accent-wash);
		color: var(--ink);
		font-weight: 600;
	}
	.macro:hover {
		background: var(--fill);
	}
	.macro .note {
		margin-left: auto;
		font-size: 11.5px;
		color: var(--faint);
	}
	.macro:first-child .note {
		color: var(--accent-soft);
	}
	.fkeys {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 6px;
	}
	.fkey {
		height: 32px;
		border: none;
		border-radius: var(--r-sm);
		background: var(--fill);
		color: var(--ink-2);
		font-size: 12px;
		cursor: pointer;
	}
	.fkey:hover {
		background: var(--accent-wash);
		color: var(--accent-tint);
	}
	.foot {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 11.5px;
		color: var(--faint);
	}
	.accent-tint {
		color: var(--accent-tint);
	}
	.close {
		margin-left: auto;
		height: 30px;
		padding: 0 13px;
		border: none;
		border-radius: 9px;
		background: var(--accent);
		color: var(--accent-ink);
		font: 700 12px/1 var(--sans);
		cursor: pointer;
	}
</style>

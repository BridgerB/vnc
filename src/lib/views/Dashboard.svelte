<script lang="ts">
import { onMount } from "svelte";
import type { Profile, ScaleMode, Settings, Target } from "$lib/types";
import Icon from "$lib/ui/Icon.svelte";
import { parseQuickConnect } from "$lib/vnc/parse.ts";
import ConnectionModal from "./ConnectionModal.svelte";
import MachineCard from "./MachineCard.svelte";

interface Props {
	profiles: Profile[];
	settings: Settings;
	activeId?: string | null;
	onconnect: (t: Target) => void;
}

let {
	profiles = $bindable(),
	settings = $bindable(),
	activeId = null,
	onconnect,
}: Props = $props();

/** null closed; "new" for a fresh connection; a Profile to edit an existing one. */
type ModalState = null | "new" | Profile;

let quick = $state("");
let reach = $state<Record<string, "checking" | "online" | "offline">>({});
let modal = $state<ModalState>(null);
let section = $state("machines"); // machines | recent | groups | settings
let tagFilter = $state<string | null>(null);
let importInput = $state<HTMLInputElement | undefined>();

const online = $derived(
	Object.values(reach).filter((s) => s === "online").length,
);
const allTags = $derived([...new Set(profiles.flatMap((p) => p.tags ?? []))]);
const filtered = $derived.by(() => {
	const t = tagFilter;
	return t ? profiles.filter((p) => (p.tags ?? []).includes(t)) : profiles;
});
const recent = $derived(
	profiles
		.filter((p) => p.lastConnected)
		.sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0)),
);
const groups = $derived(
	[
		...allTags.map((t) => ({
			tag: t,
			items: profiles.filter((p) => (p.tags ?? []).includes(t)),
		})),
		{ tag: "untagged", items: profiles.filter((p) => !(p.tags ?? []).length) },
	].filter((g) => g.items.length),
);

const sections = [
	{ id: "machines", label: "Machines", icon: "grid" },
	{ id: "recent", label: "Recent", icon: "clock" },
	{ id: "groups", label: "Groups", icon: "layers" },
	{ id: "settings", label: "Settings", icon: "cog" },
];
const scaleModes: { id: ScaleMode; label: string }[] = [
	{ id: "fit", label: "Fit to window" },
	{ id: "actual", label: "1:1 pixels" },
	{ id: "stretch", label: "Stretch" },
];

// The boolean session preferences, each with its label and hint.
type ToggleKey =
	| "autoReconnect"
	| "clipboardSync"
	| "localCursor"
	| "showStats"
	| "viewOnly";
const behaviourToggles: [key: ToggleKey, title: string, hint: string][] = [
	["autoReconnect", "Auto-reconnect", "Retry with exponential backoff"],
	["clipboardSync", "Clipboard sync", "Bidirectional, text only"],
	["localCursor", "Local cursor", "Draw the remote cursor client-side"],
	["showStats", "Stats overlay", "Show fps / bandwidth on the session"],
	["viewOnly", "View only", "Drop all input by default"],
];

onMount(pingAll);
function pingAll() {
	for (const p of profiles) ping(p);
}
async function ping(p: Profile) {
	reach = { ...reach, [p.id]: "checking" };
	try {
		const r = await fetch(
			`/api/ping?host=${encodeURIComponent(p.host)}&port=${p.port}`,
		);
		const j = await r.json();
		reach = { ...reach, [p.id]: j.open ? "online" : "offline" };
	} catch {
		reach = { ...reach, [p.id]: "offline" };
	}
}

function go(s: string) {
	section = s;
	tagFilter = null;
}
function filterTag(t: string) {
	section = "machines";
	tagFilter = tagFilter === t ? null : t;
}

function quickConnect() {
	const hp = parseQuickConnect(quick);
	if (!hp) return;
	onconnect({ host: hp.host, port: hp.port, name: hp.host });
}

function saveModal(p: Profile, connect: boolean) {
	const i = profiles.findIndex((x) => x.id === p.id);
	if (i >= 0) profiles[i] = p;
	else profiles = [...profiles, p];
	ping(p);
	modal = null;
	if (connect)
		onconnect({
			id: p.id,
			host: p.host,
			port: p.port,
			password: p.password,
			name: p.name,
			kind: p.kind,
		});
}
function del(id: string) {
	profiles = profiles.filter((p) => p.id !== id);
}
function open(p: Profile) {
	onconnect({
		id: p.id,
		host: p.host,
		port: p.port,
		password: p.password,
		name: p.name,
		kind: p.kind,
	});
}

function exportProfiles() {
	const blob = new Blob([JSON.stringify(profiles, null, 2)], {
		type: "application/json",
	});
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "vnc-machines.json";
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importProfiles(e: Event) {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) return;
	try {
		const list = JSON.parse(await file.text()) as Profile[];
		if (Array.isArray(list)) {
			const ids = new Set(profiles.map((p) => p.id));
			profiles = [...profiles, ...list.filter((p) => p?.id && !ids.has(p.id))];
			for (const p of list) ping(p);
		}
	} catch {
		/* ignore malformed */
	}
	if (importInput) importInput.value = "";
}
function clearAll() {
	if (confirm("Remove all saved machines? This cannot be undone."))
		profiles = [];
}
</script>

<div class="dash">
	<aside class="side">
		<div class="brand">
			<span class="logo">R</span>
			<span class="wordmark">vnc</span>
			<span class="ver mono">v2.4</span>
		</div>
		<nav>
			<div class="eyebrow navhead">Workspace</div>
			{#each sections as s}
				<button class="nav" class:on={section === s.id} onclick={() => go(s.id)}>
					<Icon name={s.icon} size={17} />{s.label}
					{#if s.id === "machines"}<span class="count mono">{profiles.length}</span>{/if}
					{#if s.id === "groups" && groups.length}<span class="count mono">{groups.length}</span>{/if}
				</button>
			{/each}
		</nav>
		{#if allTags.length}
			<div class="tags">
				<div class="eyebrow navhead">Tags</div>
				{#each allTags as t}
					<button class="tagrow" class:on={tagFilter === t} onclick={() => filterTag(t)}>
						<span class="sw {t}"></span>{t}
					</button>
				{/each}
			</div>
		{/if}
		<div class="agent">
			<div class="agent-h"><Icon name="shield" size={15} class="ok" />Local access</div>
			<div class="agent-b">Direct &amp; tunnelled VNC over your network</div>
		</div>
	</aside>

	<main>
		<header class="topbar">
			<div>
				<div class="h1">{sections.find((s) => s.id === section)?.label}{#if tagFilter}<span class="crumb"> · {tagFilter}</span>{/if}</div>
				{#if section === "machines"}
					<div class="h2">{filtered.length} shown · <span class="ok">{online} online</span></div>
				{:else if section === "recent"}
					<div class="h2">{recent.length} recently connected</div>
				{:else if section === "groups"}
					<div class="h2">{groups.length} groups</div>
				{:else}
					<div class="h2">Defaults &amp; data · applies to every session</div>
				{/if}
			</div>
			{#if section === "machines" || section === "recent"}
				<form class="quick" onsubmit={(e) => (e.preventDefault(), quickConnect())}>
					<div class="field mono qfield">
						<Icon name="search" size={16} class="accent" />
						<input bind:value={quick} placeholder="user@host:port" />
						<span class="ret mono">⏎</span>
					</div>
					<button type="submit" class="btn btn-primary"><Icon name="mon" size={16} />Quick connect</button>
					<button type="button" class="newbtn" onclick={() => (modal = "new")} aria-label="New connection"><Icon name="plus" size={17} /></button>
				</form>
			{/if}
		</header>

		<div class="content">
			{#if section === "machines" && profiles.length === 0}
				<div class="empty">
					<div class="empty-icon">
						<Icon name="mon" size={40} stroke={1.6} />
						<span class="badge"><Icon name="plus" size={16} stroke={2.2} /></span>
					</div>
					<div class="empty-copy">
						<div class="empty-h">Add your first machine</div>
						<div class="empty-p">vnc speaks plain RFB — any VNC server works: TigerVNC, x11vnc, wayvnc, macOS Screen Sharing, a Raspberry Pi kiosk.</div>
					</div>
					<form class="empty-field" onsubmit={(e) => (e.preventDefault(), quickConnect())}>
						<div class="field mono"><Icon name="search" size={16} class="dim" /><input bind:value={quick} placeholder="10.42.7.18:5901" /></div>
						<button type="submit" class="btn btn-primary" style="height:46px;padding:0 20px">Connect</button>
					</form>
					<button class="addcard mini" onclick={() => (modal = "new")}>Add manually instead</button>
				</div>
			{:else if section === "machines"}
				<div class="grid">
					{#each filtered as p (p.id)}<MachineCard {p} status={reach[p.id]} active={p.id === activeId} onopen={() => open(p)} ondelete={() => del(p.id)} onedit={() => (modal = p)} />{/each}
					<button class="addcard" onclick={() => (modal = "new")}>
						<span class="add-icon"><Icon name="plus" size={20} stroke={2} /></span>
						<span class="add-t">Add a machine</span>
						<span class="add-s">or paste a host to quick-connect</span>
					</button>
				</div>
			{:else if section === "recent"}
				{#if recent.length}
					<div class="grid">{#each recent as p (p.id)}<MachineCard {p} status={reach[p.id]} active={p.id === activeId} onopen={() => open(p)} ondelete={() => del(p.id)} onedit={() => (modal = p)} />{/each}</div>
				{:else}
					<div class="note-empty"><Icon name="clock" size={22} />No recent connections yet.</div>
				{/if}
			{:else if section === "groups"}
				{#if groups.length}
					<div class="groups">
						{#each groups as g}
							<div class="group">
								<div class="group-h"><span class="sw {g.tag}"></span>{g.tag}<span class="count mono">{g.items.length}</span></div>
								<div class="grid">{#each g.items as p (p.id)}<MachineCard {p} status={reach[p.id]} active={p.id === activeId} onopen={() => open(p)} ondelete={() => del(p.id)} onedit={() => (modal = p)} />{/each}</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="note-empty"><Icon name="layers" size={22} />No groups — add tags to your machines.</div>
				{/if}
			{:else if section === "settings"}
				<div class="settings">
					<div class="scol">
						<div class="panel-card">
							<div class="eyebrow">Default display</div>
							<div class="segmented">
								{#each scaleModes as m}
									<button class:on={settings.scaleMode === m.id} onclick={() => (settings.scaleMode = m.id)}>{m.label}</button>
								{/each}
							</div>
						</div>
						<div class="panel-card">
							<div class="eyebrow">Quality</div>
							<div class="slider-head"><span>Image quality</span><span class="mono val">{settings.quality} / 9</span></div>
							<input class="slider" type="range" min="0" max="9" bind:value={settings.quality} style="--pct:{(settings.quality / 9) * 100}%" />
							<div class="slider-head" style="margin-top:16px"><span>Compression</span><span class="mono val">{settings.compression} / 9</span></div>
							<input class="slider" type="range" min="0" max="9" bind:value={settings.compression} style="--pct:{(settings.compression / 9) * 100}%" />
						</div>
					</div>
					<div class="scol">
						<div class="panel-card">
							<div class="eyebrow">Behaviour</div>
							{#each behaviourToggles as [key, title, hint]}
								<div class="srow">
									<div><div class="srow-t">{title}</div><div class="hint">{hint}</div></div>
									<button class="toggle" role="switch" aria-checked={settings[key]} aria-label={title} onclick={() => (settings[key] = !settings[key])}></button>
								</div>
							{/each}
						</div>
						<div class="panel-card">
							<div class="eyebrow">Data</div>
							<div class="hint" style="margin-bottom:12px">{profiles.length} machines stored locally on this device.</div>
							<div class="data-actions">
								<button class="btn" onclick={exportProfiles}><Icon name="layers" size={15} />Export</button>
								<button class="btn" onclick={() => importInput?.click()}><Icon name="plus" size={15} />Import</button>
								<button class="btn btn-danger" onclick={clearAll}><Icon name="x" size={15} />Clear all</button>
							</div>
							<input bind:this={importInput} type="file" accept="application/json" onchange={importProfiles} hidden />
						</div>
					</div>
				</div>
			{/if}
		</div>
	</main>
</div>

{#if modal}
	<ConnectionModal profile={modal === "new" ? null : modal} onsave={saveModal} oncancel={() => (modal = null)} />
{/if}

<style>
	.dash {
		display: flex;
		height: 100vh;
		background: var(--bg);
		overflow: hidden;
	}
	.side {
		width: 236px;
		flex: none;
		background: var(--chrome);
		border-right: 1px solid var(--line-soft);
		padding: 20px 14px;
		display: flex;
		flex-direction: column;
		gap: 26px;
		overflow-y: auto;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 8px;
	}
	.logo {
		width: 26px;
		height: 26px;
		border-radius: var(--r-sm);
		background: linear-gradient(150deg, var(--accent-soft), var(--accent-press));
		display: flex;
		align-items: center;
		justify-content: center;
		font: 800 13px/1 var(--sans);
		color: var(--accent-ink);
	}
	.wordmark {
		font: 700 15px/1 var(--sans);
		letter-spacing: -0.01em;
	}
	.ver {
		margin-left: auto;
		font-size: 10px;
		color: var(--faint);
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.navhead {
		padding: 0 10px 8px;
	}
	.nav {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 9px 10px;
		border: none;
		background: none;
		border-radius: 9px;
		color: var(--muted);
		font: 500 13px/1 var(--sans);
		cursor: pointer;
		text-align: left;
		width: 100%;
	}
	.nav:hover {
		background: var(--fill);
		color: var(--ink-2);
	}
	.nav.on {
		background: var(--accent-wash);
		color: var(--accent-tint);
		font-weight: 600;
	}
	.count {
		margin-left: auto;
		font-size: 11px;
		color: var(--faint);
	}
	.nav.on .count {
		color: var(--accent-soft);
	}
	.tags {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tagrow {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 7px 10px;
		border: none;
		background: none;
		border-radius: 8px;
		color: var(--muted);
		font: 500 12.5px/1 var(--sans);
		cursor: pointer;
		text-align: left;
		width: 100%;
	}
	.tagrow:hover {
		background: var(--fill);
	}
	.tagrow.on {
		background: var(--accent-wash);
		color: var(--accent-tint);
	}
	.sw {
		width: 7px;
		height: 7px;
		border-radius: 2px;
		background: var(--accent);
		flex: none;
	}
	.sw.lab {
		background: var(--online);
	}
	.sw.qa {
		background: var(--warn);
	}
	.sw.untagged {
		background: var(--disabled);
	}
	.agent {
		margin-top: auto;
		padding: 12px;
		border-radius: 12px;
		background: var(--surface);
		border: 1px solid var(--line-soft);
	}
	.agent-h {
		display: flex;
		align-items: center;
		gap: 8px;
		font: 600 12px/1 var(--sans);
		margin-bottom: 6px;
	}
	.agent-h :global(.ok) {
		color: var(--online);
	}
	.agent-b {
		font: 400 11.5px/1.45 var(--sans);
		color: var(--muted);
	}

	main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.topbar {
		height: 76px;
		flex: none;
		padding: 0 28px;
		display: flex;
		align-items: center;
		gap: 16px;
		border-bottom: 1px solid var(--line-soft);
	}
	.h1 {
		font: 700 18px/1.1 var(--sans);
		letter-spacing: -0.015em;
	}
	.crumb {
		color: var(--accent-soft);
	}
	.h2 {
		font: 400 12px/1 var(--sans);
		color: var(--muted);
		margin-top: 5px;
	}
	.ok {
		color: var(--online);
	}
	.quick {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.qfield {
		width: 340px;
		height: 40px;
	}
	.qfield :global(.accent) {
		color: var(--accent);
	}
	.ret {
		font-size: 10px;
		color: var(--faint);
		padding: 3px 5px;
		border-radius: 4px;
		background: var(--fill);
	}
	.btn-primary {
		height: 40px;
		padding: 0 16px;
		border-radius: var(--r-md);
	}
	.newbtn {
		width: 40px;
		height: 40px;
		border-radius: var(--r-md);
		background: var(--surface);
		border: 1px solid var(--line-2);
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.newbtn:hover {
		background: var(--fill);
		color: var(--ink);
	}

	.content {
		flex: 1;
		overflow-y: auto;
	}
	.grid {
		padding: 24px 28px;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		grid-auto-rows: min-content;
		gap: 18px;
		align-content: start;
	}
	.groups .grid {
		padding: 16px 0 0;
	}
	.groups {
		padding: 24px 28px;
		display: flex;
		flex-direction: column;
		gap: 30px;
	}
	.group-h {
		display: flex;
		align-items: center;
		gap: 9px;
		font: 600 13px/1 var(--sans);
		text-transform: capitalize;
	}
	.group-h .count {
		margin-left: 0;
		color: var(--faint);
	}
	.addcard {
		border-radius: var(--r-lg);
		background: rgba(255, 255, 255, 0.02);
		border: 1px dashed rgba(255, 255, 255, 0.14);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		min-height: 288px;
		color: var(--muted);
		cursor: pointer;
		font: inherit;
	}
	.addcard:hover {
		border-color: var(--accent-ring);
		background: rgba(255, 106, 61, 0.04);
	}
	.add-icon {
		width: 44px;
		height: 44px;
		border-radius: 13px;
		background: var(--accent-wash);
		color: var(--accent-soft);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.add-t {
		font: 600 13px/1 var(--sans);
		color: var(--ink);
	}
	.add-s {
		font: 400 11.5px/1 var(--sans);
	}
	.note-empty {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 40px 28px;
		color: var(--faint);
		font: 500 13px/1 var(--sans);
	}

	/* settings */
	.settings {
		padding: 24px 28px;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 18px;
		max-width: 980px;
	}
	.scol {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.panel-card {
		padding: 20px;
		border-radius: var(--r-lg);
		background: var(--surface);
		border: 1px solid var(--line);
	}
	.panel-card .eyebrow {
		margin-bottom: 14px;
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
		height: 34px;
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
		background: linear-gradient(to right, var(--accent) 0 var(--pct), rgba(255, 255, 255, 0.09) var(--pct) 100%);
		outline: none;
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
		cursor: pointer;
	}
	.srow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 11px 0;
		border-top: 1px solid var(--line-soft);
	}
	.srow:first-of-type {
		border-top: none;
		padding-top: 0;
	}
	.srow-t {
		font: 500 13px/1 var(--sans);
	}
	.hint {
		font: 400 11.5px/1.45 var(--sans);
		color: var(--faint);
		margin-top: 6px;
	}
	.data-actions {
		display: flex;
		gap: 8px;
	}

	.empty {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 30px;
		padding: 60px;
	}
	.empty-icon {
		width: 96px;
		height: 96px;
		border-radius: 28px;
		background: linear-gradient(155deg, rgba(255, 106, 61, 0.22), rgba(255, 106, 61, 0.05));
		box-shadow: inset 0 0 0 1px rgba(255, 106, 61, 0.35);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--accent-soft);
		position: relative;
	}
	.badge {
		position: absolute;
		right: -6px;
		bottom: -6px;
		width: 30px;
		height: 30px;
		border-radius: 11px;
		background: var(--accent);
		color: var(--accent-ink);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 8px 20px rgba(255, 106, 61, 0.5);
	}
	.empty-copy {
		text-align: center;
		max-width: 520px;
	}
	.empty-h {
		font: 800 26px/1.2 var(--sans);
		letter-spacing: -0.02em;
	}
	.empty-p {
		font: 400 14px/1.6 var(--sans);
		color: var(--muted);
		margin-top: 12px;
	}
	.empty-field {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 520px;
		max-width: 100%;
	}
	.empty-field .field {
		flex: 1;
		height: 46px;
	}
	.empty-field :global(.dim) {
		color: var(--faint);
	}
	.mini {
		min-height: 0;
		padding: 10px 16px;
		border-radius: var(--r);
		font-size: 12.5px;
	}
</style>

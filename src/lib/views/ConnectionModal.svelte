<script lang="ts">
import { untrack } from "svelte";
import type { Profile } from "$lib/types";
import Icon from "$lib/ui/Icon.svelte";
import { parseHostPort } from "$lib/vnc/parse.ts";
import { newId } from "$lib/vnc/profiles.ts";

interface Props {
	profile?: Profile | null;
	onsave: (p: Profile, connect: boolean) => void;
	oncancel: () => void;
}

let { profile = null, onsave, oncancel }: Props = $props();

// The form snapshots the profile once at open (untrack silences the reactive
// read warning — later prop changes shouldn't clobber in-progress edits).
let host = $state(untrack(() => profile?.host ?? ""));
let port = $state(untrack(() => profile?.port ?? 5900));
let displayName = $state(untrack(() => profile?.name ?? ""));
let password = $state(untrack(() => profile?.password ?? ""));
let showPw = $state(false);
let tags = $state(untrack(() => [...(profile?.tags ?? [])]));
let tagDraft = $state("");
let testState = $state<null | "testing" | "ok" | "fail">(null);
let testMs = $state(0);

const isEdit = $derived(!!profile);

// Split a pasted "host:port" across the two fields; otherwise keep raw input
// so the host field stays editable while typing.
function onHostInput(e: Event) {
	const v = (e.target as HTMLInputElement).value;
	const hp = v.includes(":") ? parseHostPort(v) : null;
	if (hp) {
		host = hp.host;
		port = hp.port;
	} else {
		host = v;
	}
}
function addTag() {
	const t = tagDraft.trim();
	if (t && !tags.includes(t)) tags = [...tags, t];
	tagDraft = "";
}
function removeTag(t: string) {
	tags = tags.filter((x) => x !== t);
}
async function test() {
	testState = "testing";
	try {
		const r = await fetch(
			`/api/ping?host=${encodeURIComponent(host)}&port=${port}`,
		);
		const j = await r.json();
		testMs = j.ms;
		testState = j.open ? "ok" : "fail";
	} catch {
		testState = "fail";
	}
}
function build(): Profile {
	return {
		id: profile?.id ?? newId(),
		name: displayName.trim() || host,
		host: host.trim(),
		port: Number(port) || 5900,
		password,
		kind: profile?.kind,
		tags,
		width: profile?.width,
		height: profile?.height,
		lastConnected: profile?.lastConnected,
		thumbnail: profile?.thumbnail,
	};
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="scrim" onclick={oncancel} role="presentation">
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
		<div class="head">
			<div>
				<div class="title">{isEdit ? "Edit connection" : "New connection"}</div>
				<div class="sub">Stored locally on this device</div>
			</div>
			<button class="iconbtn" onclick={oncancel} aria-label="Close"><Icon name="x" size={15} /></button>
		</div>

		<div class="body">
			<div class="two">
				<div class="f">
					<div class="lbl">Host</div>
					<div class="field mono"><input value={host} oninput={onHostInput} placeholder="10.42.7.18" /></div>
				</div>
				<div class="f" style="width:120px;flex:none">
					<div class="lbl">Port</div>
					<div class="field mono"><input type="number" bind:value={port} /></div>
				</div>
			</div>
			<div class="f">
				<div class="lbl">Display name</div>
				<div class="field"><input bind:value={displayName} placeholder="nas-freebsd" /></div>
			</div>
			<div class="f">
				<div class="lbl">Password <span class="opt">optional — prompt each time if empty</span></div>
				<div class="field">
					<Icon name="lock" size={15} class="dim" />
					{#if showPw}
						<input bind:value={password} placeholder="" />
					{:else}
						<input type="password" bind:value={password} placeholder="" />
					{/if}
					<button class="eye" onclick={() => (showPw = !showPw)} aria-label="Toggle password"><Icon name="eye" size={16} /></button>
				</div>
			</div>
			<div class="f">
				<div class="lbl">Tags</div>
				<div class="tagfield">
					{#each tags as t}
						<span class="tag {t}">
							<span class="swatch"></span>{t}
							<button onclick={() => removeTag(t)} aria-label="Remove tag"><Icon name="x" size={11} /></button>
						</span>
					{/each}
					<input
						bind:value={tagDraft}
						placeholder="Add tag…"
						onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())}
					/>
				</div>
			</div>
		</div>

		<div class="foot">
			<button class="btn" onclick={test}>
				<Icon name="refresh" size={15} />
				{#if testState === "testing"}Testing…{:else if testState === "ok"}<span class="ok">Reachable · {testMs}ms</span>{:else if testState === "fail"}<span class="fail">Unreachable</span>{:else}Test connection{/if}
			</button>
			<button class="btn btn-ghost" style="margin-left:auto" onclick={oncancel}>Cancel</button>
			<button class="btn btn-primary" onclick={() => onsave(build(), true)}>Save &amp; connect</button>
		</div>
	</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: rgba(7, 9, 15, 0.62);
		backdrop-filter: blur(9px);
		-webkit-backdrop-filter: blur(9px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		animation: fade 0.16s ease;
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	.modal {
		width: 620px;
		max-width: calc(100vw - 32px);
		border-radius: 18px;
		background: var(--modal);
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.09), 0 40px 90px rgba(0, 0, 0, 0.65);
		color: var(--ink);
		overflow: hidden;
	}
	.head {
		padding: 22px 24px 0;
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}
	.title {
		font: 700 17px/1.1 var(--sans);
		letter-spacing: -0.01em;
	}
	.sub {
		font: 400 12px/1 var(--sans);
		color: var(--muted);
		margin-top: 7px;
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
	.body {
		padding: 22px 24px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.two {
		display: flex;
		gap: 14px;
	}
	.f {
		flex: 1;
		min-width: 0;
	}
	.lbl {
		font: 600 11px/1 var(--sans);
		color: var(--muted);
		margin-bottom: 8px;
		display: flex;
		gap: 9px;
		align-items: baseline;
	}
	.opt {
		font-weight: 400;
		color: var(--faint);
	}
	.field :global(.dim) {
		color: var(--faint);
	}
	.eye {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		display: flex;
		padding: 0;
	}
	.tagfield {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		min-height: 42px;
		padding: 8px 10px;
		border-radius: var(--r-md);
		background: var(--void);
		border: 1px solid var(--line-2);
	}
	.tagfield input {
		flex: 1;
		min-width: 80px;
		background: none;
		border: none;
		outline: none;
		color: var(--ink);
		font: 400 12.5px/1 var(--sans);
	}
	.tagfield input::placeholder {
		color: var(--faint);
	}
	.tag {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 5px 9px;
	}
	.tag .swatch {
		width: 6px;
		height: 6px;
		border-radius: 2px;
		background: var(--accent);
	}
	.tag.lab .swatch {
		background: var(--online);
	}
	.tag.qa .swatch {
		background: var(--warn);
	}
	.tag button {
		background: none;
		border: none;
		color: currentColor;
		cursor: pointer;
		display: flex;
		padding: 0;
		opacity: 0.7;
	}
	.foot {
		padding: 16px 24px;
		border-top: 1px solid var(--line);
		display: flex;
		align-items: center;
		gap: 10px;
		background: rgba(255, 255, 255, 0.02);
	}
	.ok {
		color: var(--online-soft);
	}
	.fail {
		color: var(--error);
	}
</style>

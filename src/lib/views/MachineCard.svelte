<script lang="ts">
import type { Profile } from "$lib/types";
import Icon from "$lib/ui/Icon.svelte";

interface Props {
	p: Profile;
	status?: "checking" | "online" | "offline";
	active?: boolean;
	onopen: () => void;
	ondelete: () => void;
	onedit: () => void;
}

let { p, status, active = false, onopen, ondelete, onedit }: Props = $props();

const gradients = [
	"linear-gradient(155deg,#2f4763,#16202e)",
	"linear-gradient(155deg,#243d52,#131c28)",
	"linear-gradient(155deg,#3a3a4d,#1a1a26)",
	"linear-gradient(155deg,#264a3f,#111f1c)",
	"linear-gradient(155deg,#2b3550,#141a28)",
];
function gi(id: string) {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return gradients[Math.abs(h) % gradients.length];
}
function fmtLast(t: number | undefined) {
	if (!t) return "Never connected";
	const s = Math.floor((Date.now() - t) / 1000);
	if (s < 60) return "Last connected just now";
	if (s < 3600) return `Last connected ${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `Last connected ${Math.floor(s / 3600)} h ago`;
	return `Last connected ${Math.floor(s / 86400)} d ago`;
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="card"
	class:active
	role="button"
	tabindex="0"
	onclick={onopen}
	onkeydown={(e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onopen();
		}
	}}
>
	<div class="thumb" style:background={p.thumbnail ? "none" : gi(p.id)}>
		{#if p.thumbnail}<img src={p.thumbnail} alt="" />{/if}
		<div class="thumb-grad"></div>
		<div class="status" class:off={status === "offline"}>
			<span class="dot" class:online={status === "online"}></span>
			{status === "online" ? "Online" : status === "checking" ? "Checking…" : "Offline"}
		</div>
		{#if active}<div class="active-badge">Session active</div>{/if}
		<button class="del" onclick={(e) => (e.stopPropagation(), ondelete())} aria-label="Delete"><Icon name="x" size={12} /></button>
	</div>
	<div class="meta">
		<div class="name-row">
			<span class="cname">{p.name}</span>
			{#each p.tags ?? [] as t}<span class="tag {t}">{t}</span>{/each}
		</div>
		<div class="addr mono">{p.host}:{p.port}{p.width ? ` · ${p.width}×${p.height}` : ""}</div>
		<div class="foot-row">
			<span class="last">{fmtLast(p.lastConnected)}</span>
			<span
				class="cog"
				onclick={(e) => (e.stopPropagation(), onedit())}
				onkeydown={(e) => e.key === "Enter" && (e.stopPropagation(), onedit())}
				role="button"
				tabindex="-1"
				aria-label="Edit"><Icon name="cog" size={15} /></span>
		</div>
	</div>
</div>

<style>
	.card {
		text-align: left;
		padding: 0;
		border-radius: var(--r-lg);
		background: var(--surface);
		border: 1px solid var(--line);
		overflow: hidden;
		cursor: pointer;
		color: inherit;
		font: inherit;
		transition: transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
	}
	.card:hover {
		transform: translateY(-2px);
		box-shadow: var(--shadow-card);
		border-color: rgba(255, 255, 255, 0.12);
	}
	.card.active {
		border-color: var(--accent-ring);
		background: var(--card);
		box-shadow: 0 14px 30px rgba(0, 0, 0, 0.45);
	}
	.thumb {
		height: 152px;
		position: relative;
		overflow: hidden;
	}
	.thumb img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.thumb-grad {
		position: absolute;
		inset: 0;
		background: linear-gradient(to top, rgba(16, 19, 23, 0.85), rgba(16, 19, 23, 0) 55%);
	}
	.status {
		position: absolute;
		left: 14px;
		top: 14px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 5px 9px;
		border-radius: 999px;
		background: rgba(16, 19, 23, 0.72);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		font: 600 10.5px/1 var(--sans);
		color: var(--ink);
	}
	.status.off {
		color: var(--muted);
	}
	.active-badge {
		position: absolute;
		right: 14px;
		top: 14px;
		padding: 5px 9px;
		border-radius: 999px;
		background: rgba(255, 106, 61, 0.9);
		font: 600 10.5px/1 var(--sans);
		color: #fff;
	}
	.del {
		position: absolute;
		right: 12px;
		bottom: 12px;
		width: 26px;
		height: 26px;
		border-radius: 8px;
		border: none;
		background: rgba(16, 19, 23, 0.75);
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.14s ease;
	}
	.card:hover .del {
		opacity: 1;
	}
	.del:hover {
		background: var(--error-wash);
		color: var(--error);
	}
	.meta {
		padding: 14px 16px 16px;
	}
	.name-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}
	.cname {
		font: 700 14.5px/1 var(--sans);
	}
	.addr {
		font-size: 12px;
		color: var(--muted);
		margin-top: 8px;
	}
	.foot-row {
		display: flex;
		align-items: center;
		margin-top: 12px;
	}
	.last {
		font: 400 11.5px/1 var(--sans);
		color: var(--faint);
	}
	.cog {
		margin-left: auto;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
	}
	.cog:hover {
		background: var(--fill);
		color: var(--ink);
	}
</style>

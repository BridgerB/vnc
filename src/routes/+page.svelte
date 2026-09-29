<script lang="ts">
import { onMount } from "svelte";
import type { ConnectedInfo, Profile, Target } from "$lib/types";
import Dashboard from "$lib/views/Dashboard.svelte";
import Session from "$lib/views/Session.svelte";
import {
	defaultSettings,
	loadProfiles,
	loadSettings,
	saveProfiles,
	saveSettings,
	updateProfile,
} from "$lib/vnc/profiles.ts";

// Start from defaults on both server and client so hydration matches; the
// persisted values are loaded in onMount (same pattern as profiles).
let profiles = $state<Profile[]>([]);
let settings = $state({ ...defaultSettings });
let view = $state<"dashboard" | "session">("dashboard");
let target = $state<Target>({
	host: "127.0.0.1",
	port: 5900,
	password: "",
	name: "",
});

let loaded = $state(false);
onMount(() => {
	profiles = loadProfiles();
	settings = loadSettings();
	loaded = true;
});
$effect(() => {
	if (loaded) saveProfiles(profiles);
});
$effect(() => {
	if (loaded) saveSettings(settings);
});

function connect(t: Target) {
	target = { password: "", ...t };
	view = "session";
}
function exit() {
	view = "dashboard";
}
function onConnected(info: ConnectedInfo) {
	if (target.id) {
		profiles = updateProfile(target.id, {
			lastConnected: Date.now(),
			width: info.width || undefined,
			height: info.height || undefined,
		});
	}
}
function onThumbnail(dataUrl: string) {
	if (target.id) profiles = updateProfile(target.id, { thumbnail: dataUrl });
}
</script>

<svelte:head><title>vnc</title></svelte:head>

{#if view === "session"}
	<Session
		{target}
		bind:settings
		label={target.name}
		onexit={exit}
		onconnected={onConnected}
		onthumbnail={onThumbnail}
	/>
{:else}
	<Dashboard bind:profiles bind:settings activeId={null} onconnect={connect} />
{/if}

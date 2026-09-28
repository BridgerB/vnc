<script lang="ts">
import type { Snippet } from "svelte";
import "../app.css";
import Sprite from "$lib/ui/Sprite.svelte";

interface Props {
	children: Snippet;
}

let { children }: Props = $props();
</script>

<Sprite />
{@render children()}

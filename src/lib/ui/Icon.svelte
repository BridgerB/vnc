<script lang="ts">
interface Props {
	name: string;
	size?: number;
	stroke?: number;
	class?: string;
}

let { name, size = 16, stroke = 1.85, class: cls = "" }: Props = $props();
</script>

<svg
	class={cls}
	viewBox="0 0 24 24"
	width={size}
	height={size}
	style="fill:none;stroke:currentColor;stroke-width:{stroke};stroke-linecap:round;stroke-linejoin:round;flex:none"
	aria-hidden="true"
>
	<use href="#r-{name}"></use>
</svg>

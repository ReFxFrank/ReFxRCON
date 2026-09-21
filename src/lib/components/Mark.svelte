<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
</script>

<!--
	Blue glass plate with a cut corner and a target reticle. The cut corner is the tactical
	signature; the gradient, hairline and outer bloom are what make it read as glass rather than
	as a flat badge. Colours come from tokens so the mark reskins with everything else.
-->
<span
	class="relative inline-flex shrink-0 items-center justify-center text-mist-100"
	style="
		width:{size}px;height:{size}px;
		clip-path:polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
		background:
			linear-gradient(180deg, rgb(255 255 255 / 0.18), rgb(255 255 255 / 0.03)),
			linear-gradient(160deg, var(--color-accent-deep), #0b4ea8 72%, #0a3a80);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.3),
			0 2px 10px -2px rgb(0 104 239 / 0.55);
	"
	aria-hidden="true"
>
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.2"
		stroke-linecap="square"
		style="width:{size * 0.62}px;height:{size * 0.62}px"
	>
		<circle cx="12" cy="12" r="6" />
		<path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
		<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
	</svg>
</span>

<script lang="ts">
	import Mark from '$lib/components/Mark.svelte';
	import type { LayoutProps } from './$types';
	let { data, children }: LayoutProps = $props();
</script>

<!-- The public shell: no navigation, no session; just the plate and whatever the page shows. -->
<div class="page-x min-h-screen py-6">
	<div class="mx-auto w-full max-w-[1100px]">
		<div class="mb-5 flex items-center gap-2.5 text-mist-400">
			<Mark size={22} />
			<span class="caps">{data.appName}</span>
			{#if data.user}
				<a href="/" class="ml-auto text-[12.5px] text-accent hover:underline">Open the panel →</a>
			{/if}
		</div>
		{@render children()}
	</div>
</div>

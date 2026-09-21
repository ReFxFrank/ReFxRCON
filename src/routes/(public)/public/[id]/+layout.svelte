<script lang="ts">
	import { page } from '$app/state';
	import DiscordMark from '$lib/components/DiscordMark.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let base = $derived(`/public/${encodeURIComponent(data.publicServer.id)}`);
	let current = $derived(page.url.pathname.slice(base.length) || '');
	const isCurrent = (path: string) =>
		current === path || (path !== '' && current.startsWith(path + '/'));
	let tabs = $derived.by(() => {
		const out: { path: string; label: string }[] = [];
		if (data.features.publicStatus) out.push({ path: '', label: 'Status' });
		if (data.features.publicStats) out.push({ path: '/stats', label: 'Leaderboard' });
		return out;
	});
</script>

<svelte:head><title>{data.publicServer.name} · {data.appName}</title></svelte:head>

<div class="mb-4 rise rounded-card border border-l-[3px] border-edge border-l-accent bg-ink-900">
	<div class="flex flex-wrap items-center gap-3 px-5 py-4">
		<div class="min-w-0 grow">
			<h1 class="truncate text-xl font-semibold tracking-tight">{data.publicServer.name}</h1>
			<div class="mt-1 text-[12.5px] text-mist-400">{data.publicOrg.name}</div>
		</div>
		<span class="inline-flex flex-wrap gap-2">
			{#if data.publicServer.join}
				<a href="{base}/join" class="btn btn-primary">Join the server</a>
			{/if}
			{#if data.publicOrg.discordUrl}
				<a href={data.publicOrg.discordUrl} target="_blank" rel="noopener noreferrer" class="btn"
					><DiscordMark /> Discord</a
				>
			{/if}
		</span>
	</div>
</div>

{#if tabs.length > 1}
	<nav class="strip mb-5 gap-1 border-b border-white/8 pb-3" aria-label="Sections">
		{#each tabs as t (t.path)}
			<a href="{base}{t.path}" class="tab-link {isCurrent(t.path) ? 'tab-link-active' : ''}"
				>{t.label}</a
			>
		{/each}
	</nav>
{/if}

{@render children()}

<p class="mt-6 text-center text-[11.5px] text-mist-600">
	Built from what the game server reports over RCON: kills, deaths and cash per player. Weapons and
	vehicles are not exposed. Powered by {data.appName}.
</p>

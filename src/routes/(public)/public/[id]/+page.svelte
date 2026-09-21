<script lang="ts">
	import { api } from '$lib/api';
	import { poll } from '$lib/poll';
	import {
		expSetLabel,
		factionColor,
		fmtDuration,
		fmtNum,
		fmtTime,
		lightingLabel,
		mapLabel
	} from '$lib/format';
	import Badge from '$lib/components/Badge.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import type { PublicStatusView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const EMPTY = { maps: [], lightings: [], experiences: [] };
	// The server-rendered status seeds the page; polling replaces it from then on.
	// svelte-ignore state_referenced_locally
	let s = $state<PublicStatusView>(data.status);
	let now = $state(Date.now());
	let id = $derived(data.publicServer.id);

	async function load() {
		try {
			s = await api<PublicStatusView>(
				'GET',
				`/api/public/servers/${encodeURIComponent(id)}/status`
			);
		} catch {
			/* keep showing the last good view; the sampled-at line says how old it is */
		}
	}
	$effect(() => {
		void id;
		const tick = setInterval(() => (now = Date.now()), 1000);
		const stop = poll(load, 10000);
		return () => {
			clearInterval(tick);
			stop();
		};
	});

	/** the match clock keeps counting from the last sample while the server was reachable */
	let clock = $derived.by(() => {
		if (s.matchSeconds === null || !s.sampledAt) return null;
		const drift = s.reachable ? Math.max(0, (now - Date.parse(s.sampledAt)) / 1000) : 0;
		return s.matchSeconds + drift;
	});
	let age = $derived(
		s.sampledAt ? Math.max(0, Math.round((now - Date.parse(s.sampledAt)) / 1000)) : null
	);
	let scores = $derived([...s.scores].sort((a, b) => b.score - a.score));
	let topScore = $derived(Math.max(1, ...scores.map((x) => x.score)));
	let leader = $derived(
		scores.length && !(scores.length > 1 && scores[1].score === scores[0].score)
			? scores[0].name
			: null
	);
	let cashTotal = $derived(s.cash.reduce((a, c) => a + c.cash, 0));
	const kd = (k: number, d: number) => (d ? (k / d).toFixed(2) : k ? `${k}.00` : '—');
	let scored = $derived(s.players.filter((p) => p.kills > 0 || p.deaths > 0));
</script>

{#if !s.reachable}
	<div class="callout mb-4 border-l-danger">
		<b>Unreachable.</b>
		{s.error}
		{#if s.sampledAt}Showing the last good sample from {fmtTime(s.sampledAt)}.{/if}
	</div>
{/if}

<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
	<div class="panel py-4">
		<div class="caps text-mist-400">Players</div>
		<div class="mt-1 font-display text-3xl font-semibold tabular">
			{s.playerCount}<span class="text-lg text-mist-400"> / {s.maxPlayers}</span>
		</div>
		{#if s.match}<div class="text-[11.5px] text-mist-600">
				peak this match {Math.max(s.match.peakPlayers, s.playerCount)}
			</div>{/if}
	</div>
	<div class="panel py-4">
		<div class="caps text-mist-400">Match clock</div>
		<div class="mt-1 font-display text-3xl font-semibold tabular">
			{clock === null ? '—' : fmtDuration(clock)}
		</div>
		{#if s.match}<div class="text-[11.5px] text-mist-600">
				started {fmtTime(s.match.startedAt)}
			</div>{/if}
	</div>
	<div class="panel py-4">
		<div class="caps text-mist-400">Map</div>
		<div class="mt-1 truncate font-display text-2xl font-semibold">
			{s.map ? mapLabel(EMPTY, s.map) : '—'}
		</div>
		<div class="truncate text-[11.5px] text-mist-600">{lightingLabel(EMPTY, s.lighting ?? '')}</div>
	</div>
	<div class="panel py-4">
		<div class="caps text-mist-400">Mode</div>
		<div class="mt-1 truncate font-display text-2xl font-semibold">
			{expSetLabel(EMPTY, s.experiences)}
		</div>
	</div>
</div>

<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<div class="panel">
		<span class="label-sm">Scores</span>
		{#each scores as f (f.name)}
			<div class="mb-2.5">
				<div class="mb-1 flex items-center justify-between gap-2 text-[13px]">
					<span class="inline-flex items-center gap-1.5">
						<FactionChip faction={f.name} />
						{#if f.name === leader}<Badge tone="accent">leading</Badge>{/if}
					</span>
					<span class="font-mono text-mist-100 tabular">{fmtNum(f.score)}</span>
				</div>
				<div class="progress">
					<span
						class="progress-bar"
						style="width:{(f.score / topScore) * 100}%;background:{factionColor(f.name, null)}"
					></span>
				</div>
			</div>
		{:else}
			<div class="text-mist-600">No scores yet.</div>
		{/each}
	</div>
	<div class="panel">
		<span class="label-sm">Cash in play</span>
		<div class="mb-2 font-display text-2xl font-semibold tabular">${fmtNum(cashTotal)}</div>
		<div class="space-y-1 text-[13px]">
			{#each s.cash as c (c.name)}
				<div class="flex items-center justify-between gap-2">
					<FactionChip faction={c.name || null} />
					<span class="font-mono text-mist-400 tabular">${fmtNum(c.cash)}</span>
				</div>
			{:else}
				<div class="text-mist-600">Nobody holding cash right now.</div>
			{/each}
		</div>
		{#if s.day}
			<p class="note">
				Last 24 h: peak {s.day.peak} · {s.day.unique} player{s.day.unique === 1 ? '' : 's'} · {s.day
					.matches} match{s.day.matches === 1 ? '' : 'es'}.
			</p>
		{/if}
	</div>
</div>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
		<span class="label-sm mb-0">Current match</span>
		<span class="text-[12px] text-mist-600"
			>{s.players.length} in this match · {scored.length} scored{#if !s.features.stats}
				· running totals since each player joined{/if}</span
		>
		<span class="ml-auto inline-flex gap-3">
			{#if data.publicServer.join}
				<a
					href="/public/{encodeURIComponent(id)}/join"
					class="text-[12px] text-accent hover:underline">Join the server →</a
				>
			{/if}
			{#if s.features.publicStats}
				<a
					href="/public/{encodeURIComponent(id)}/stats"
					class="text-[12px] text-accent hover:underline">All-time leaderboard →</a
				>
			{/if}
		</span>
	</div>
	<div class="max-h-[60vh] table-wrap">
		<table>
			<thead
				><tr
					><th class="num">#</th><th>Player</th><th>Faction</th><th class="num">K</th><th
						class="num">D</th
					><th class="num">K/D</th></tr
				></thead
			>
			<tbody>
				{#each scored as p, i (p.steamId)}
					<tr class={p.online ? '' : 'text-mist-600'}>
						<td class="num font-display text-[15px] {i < 3 ? 'text-accent' : ''}">{i + 1}</td>
						<td>
							{#if s.features.publicStats}
								<a
									href="/public/{encodeURIComponent(id)}/players/{p.steamId}"
									class="hover:text-accent hover:underline">{p.name}</a
								>
							{:else}{p.name}{/if}
							{#if !p.online}<Badge class="ml-1">left</Badge>{/if}
						</td>
						<td><FactionChip faction={p.faction} /></td>
						<td class="num">{p.kills}</td>
						<td class="num">{p.deaths}</td>
						<td class="num">{kd(p.kills, p.deaths)}</td>
					</tr>
				{:else}
					<tr
						><td colspan="6" class="py-8 text-center text-mist-600"
							>{s.players.length ? 'Nobody has scored yet.' : 'Nobody is playing right now.'}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="note">
		{#if age !== null}Sampled {age}s ago · the panel polls the server every {s.pollSeconds}s and
			this page refreshes every 10s.{:else}Not sampled yet.{/if}
	</p>
</div>

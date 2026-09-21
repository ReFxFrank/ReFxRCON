<script lang="ts">
	import { expSetLabel, fmtNum, fmtTime, mapLabel } from '$lib/format';
	import Badge from '$lib/components/Badge.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const EMPTY = { maps: [], lightings: [], experiences: [] };
	let c = $derived(data.career);
	let id = $derived(data.publicServer.id);
	const minutes = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
	const kd = (k: number, dd: number) => (dd ? (k / dd).toFixed(2) : k ? `${k}.00` : '—');
	const RESULT_TONE = { win: 'ok', loss: 'err', draw: 'info' } as const;
	const ordinal = (n: number) => {
		const s = n % 100;
		if (s >= 11 && s <= 13) return `${n}th`;
		return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
	};
	const rankText = (r: number | null) =>
		r === null ? (c.ranks.eligible ? 'unranked' : '—') : `${ordinal(r)} of ${c.ranks.eligible}`;
	const winPct = (b: { wins: number; losses: number; draws: number }) => {
		const n = b.wins + b.losses + b.draws;
		return n ? `${Math.round((b.wins / n) * 100)}%` : '—';
	};
	let maxMapMinutes = $derived(Math.max(1, ...c.maps.map((m) => m.minutes)));
</script>

<svelte:head><title>{data.name} · {data.publicServer.name} · {data.appName}</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<a href="/public/{encodeURIComponent(id)}/stats" class="caps text-mist-400 hover:text-mist-100"
		>← Leaderboard</a
	>
	<h2 class="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
		{#if data.steam?.avatar}<img
				src={data.steam.avatar}
				alt=""
				class="h-8 w-8 rounded-[2px] border border-black"
				referrerpolicy="no-referrer"
			/>{/if}
		<span class="truncate">{data.name}</span>
		{#if c.streak && c.streak.length >= 2}
			<Badge tone={RESULT_TONE[c.streak.result]}
				>{c.streak.length}
				{c.streak.result === 'win' ? 'wins' : c.streak.result === 'loss' ? 'losses' : 'draws'} in a row</Badge
			>
		{/if}
	</h2>
	{#if data.steam?.profileUrl}<a
			href={data.steam.profileUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="text-[12.5px] text-accent hover:underline">Steam profile ↗</a
		>{/if}
</div>

{#if c.matches || c.recent.length}
	<div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
		{#each [['Matches', fmtNum(c.matches), rankText(c.ranks.minutes) + ' by playtime'], ['Record', `${c.wins}–${c.losses}–${c.draws}`, c.winRate === null ? 'win % after 3 decided' : `${c.winRate}% · ${rankText(c.ranks.winRate)}`], ['Kills', fmtNum(c.kills), rankText(c.ranks.kills)], ['K/D', c.kd.toFixed(2), rankText(c.ranks.kd)], ['Kills / h', c.kph.toFixed(1), rankText(c.ranks.kph)], ['Best match', fmtNum(c.bestKills) + ' kills', c.since ? `since ${fmtTime(c.since).slice(0, 12)}` : '']] as [label, value, sub] (label)}
			<div class="panel py-4">
				<div class="caps text-mist-400">{label}</div>
				<div class="mt-0.5 font-display text-2xl font-semibold tabular">{value}</div>
				<div class="text-[11.5px] text-mist-600">{sub}</div>
			</div>
		{/each}
	</div>

	<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
		<div class="panel">
			<span class="label-sm">By map</span>
			{#each c.maps as m (m.map)}
				<div class="mb-2.5">
					<div class="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
						<span
							>{m.map ? mapLabel(EMPTY, m.map) : 'Unknown map'}
							<span class="text-mist-600"
								>· {m.matches} match{m.matches === 1 ? '' : 'es'} · {winPct(m)} won · K/D {kd(
									m.kills,
									m.deaths
								)}</span
							></span
						><span class="font-mono text-mist-400 tabular">{minutes(m.minutes)}</span>
					</div>
					<div class="progress">
						<span class="progress-bar" style="width:{(m.minutes / maxMapMinutes) * 100}%"></span>
					</div>
				</div>
			{:else}
				<div class="text-[13px] text-mist-600">No completed matches yet.</div>
			{/each}
		</div>
		<div class="panel">
			<span class="label-sm">By faction</span>
			<div class="table-wrap">
				<table>
					<thead
						><tr
							><th>Faction</th><th class="num">Matches</th><th class="num">W / L / D</th><th
								class="num">K/D</th
							><th class="num">Time</th></tr
						></thead
					>
					<tbody>
						{#each c.factions as f (f.faction)}
							<tr>
								<td><FactionChip faction={f.faction} /></td>
								<td class="num">{f.matches}</td>
								<td class="num whitespace-nowrap">{f.wins} / {f.losses} / {f.draws}</td>
								<td class="num">{kd(f.kills, f.deaths)}</td>
								<td class="num">{minutes(f.minutes)}</td>
							</tr>
						{:else}
							<tr><td colspan="5" class="py-4 text-center text-mist-600">—</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</div>

	<div class="panel">
		<span class="label-sm">Recent matches</span>
		<div class="max-h-[420px] table-wrap">
			<table>
				<thead
					><tr
						><th>Started</th>{#if data.servers.length > 1}<th>Server</th>{/if}<th>Map</th><th
							>Faction</th
						><th>Result</th><th class="num">Time</th><th class="num">K</th><th class="num">D</th
						></tr
					></thead
				>
				<tbody>
					{#each c.recent as m (m.matchId)}
						<tr class={m.counted ? '' : 'text-mist-600'}>
							<td class="whitespace-nowrap">{fmtTime(m.startedAt)}</td>
							{#if data.servers.length > 1}<td>{m.serverName}</td>{/if}
							<td
								>{m.map ? mapLabel(EMPTY, m.map) : '—'}
								{#if m.experiences}<span class="text-[11.5px] text-mist-600"
										>· {expSetLabel(EMPTY, m.experiences.split('+'))}</span
									>{/if}</td
							>
							<td><FactionChip faction={m.faction} /></td>
							<td>
								{#if m.live}<Badge tone="info">live</Badge>
								{:else if m.result}<Badge tone={RESULT_TONE[m.result]}>{m.result}</Badge>
								{:else}<span class="text-mist-600">—</span>{/if}
							</td>
							<td class="num" title={m.counted ? '' : 'Too short to count as a match played'}
								>{minutes(m.minutes)}</td
							>
							<td class="num">{m.kills}</td><td class="num">{m.deaths}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			Ranks are on the all-time board with at least {c.ranks.minMinutes} minutes in matches; a match needs
			5 minutes' presence to count.
		</p>
	</div>
{:else}
	<div class="panel text-[13px] text-mist-600">
		No matches recorded for this player on {data.publicOrg.name}'s public servers yet.
	</div>
{/if}

<script lang="ts">
	import { api, errorMessage, qs } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import type { CareerRange, LeaderboardSort, LeaderboardView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let scope = $state<'server' | 'org'>('org');
	let range = $state<CareerRange>('30d');
	let sort = $state<LeaderboardSort>('kills');
	let min = $state(30);
	let search = $state('');
	let board = $state<LeaderboardView | null>(null);
	let loading = $state(false);

	async function load() {
		loading = true;
		try {
			board = await api<LeaderboardView>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/leaderboards${qs({ scope, range, sort, min })}`
			);
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void [id, scope, range, sort, min];
		return poll(load, 60000);
	});

	const RANGES: { key: CareerRange; label: string }[] = [
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' },
		{ key: '90d', label: '90 days' },
		{ key: 'all', label: 'All time' }
	];
	const FLOORS = [0, 30, 60, 180, 600];
	/** columns in table order; the sort key is what the header sets */
	const COLUMNS: { key: LeaderboardSort; label: string; title: string }[] = [
		{ key: 'minutes', label: 'Playtime', title: 'Time in matches' },
		{ key: 'matches', label: 'Matches', title: 'Matches played for at least the minimum presence' },
		{ key: 'wins', label: 'W / L / D', title: 'Wins, losses and draws' },
		{ key: 'winRate', label: 'Win %', title: 'Wins over decided matches' },
		{ key: 'kills', label: 'Kills', title: 'Kills' },
		{ key: 'deaths', label: 'Deaths', title: 'Deaths' },
		{ key: 'kd', label: 'K/D', title: 'Kills per death (kills when never died)' },
		{ key: 'kph', label: 'Kills/h', title: 'Kills per hour in matches' },
		{ key: 'cash', label: 'Cash', title: 'Cash held at the last sample' }
	];
	const minutes = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const all = board?.rows ?? [];
		return q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.steamId.includes(q)) : all;
	});
	let scopeLabel = $derived(
		scope === 'org'
			? `${data.server.orgName} · ${board?.servers.length ?? 0} servers`
			: data.server.name
	);
</script>

<svelte:head><title>Leaderboards · {data.server.name} · {data.appName}</title></svelte:head>

{#if !data.server.features.stats}
	<div class="callout mb-4 border-l-warn">
		<b>Match statistics are off for this server</b>, so no new rows are recorded here.
		{#if !data.server.allowed.allowStats}The site owner has not allowed them for {data.server
				.orgName}.{:else if data.server.manager}Switch them on under Servers → Edit.{:else}An owner
			of {data.server.orgName} can switch them on under Servers.{/if}
		Rows from other servers, or from before, still show.
	</div>
{/if}

<div class="mb-4 flex flex-wrap items-center gap-2">
	<div class="join">
		<button
			class="btn btn-sm {scope === 'org' ? 'btn-primary' : ''}"
			onclick={() => (scope = 'org')}>Organisation</button
		>
		<button
			class="btn btn-sm {scope === 'server' ? 'btn-primary' : ''}"
			onclick={() => (scope = 'server')}>This server</button
		>
	</div>
	<div class="join">
		{#each RANGES as r (r.key)}
			<button
				class="btn btn-sm {range === r.key ? 'btn-primary' : ''}"
				onclick={() => (range = r.key)}>{r.label}</button
			>
		{/each}
	</div>
	<label class="inline-flex items-center gap-1.5 text-[12.5px] text-mist-400">
		at least
		<select class="input w-auto py-1" bind:value={min}>
			{#each FLOORS as f (f)}
				<option value={f}>{f === 0 ? 'any playtime' : minutes(f)}</option>
			{/each}
		</select>
	</label>
	<input
		class="input w-full sm:ml-auto sm:w-[220px]"
		type="search"
		placeholder="Find a player…"
		bind:value={search}
	/>
</div>

{#if board}
	<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
		{#each [['Ranked players', fmtNum(board.eligible)], ['Seen in matches', fmtNum(board.players)], ['Scope', scopeLabel], ['Since', board.from ? fmtTime(board.from).slice(0, 12) : 'the first recorded match']] as [label, value] (label)}
			<div class="panel py-4">
				<div class="caps text-mist-400">{label}</div>
				<div class="mt-1 truncate font-display text-2xl font-semibold tabular" title={value}>
					{value}
				</div>
			</div>
		{/each}
	</div>

	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
			<span class="label-sm mb-0">Leaderboard</span>
			<span class="text-[12px] text-mist-600"
				>click a column to rank by it{#if loading}
					· refreshing…{/if}</span
			>
		</div>
		<div class="max-h-[70vh] table-wrap">
			<table>
				<thead>
					<tr>
						<th class="num">#</th>
						<th>Player</th>
						{#each COLUMNS as c (c.key)}
							<th class="num">
								<button
									class="caps whitespace-nowrap {sort === c.key
										? 'text-accent'
										: 'hover:text-mist-100'}"
									title={c.title}
									onclick={() => (sort = c.key)}
									>{c.label}{#if sort === c.key}
										▾{/if}</button
								>
							</th>
						{/each}
						<th>Last seen</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.steamId)}
						<tr>
							<td class="num font-display text-[15px] {r.rank <= 3 ? 'text-accent' : ''}"
								>{r.rank}</td
							>
							<td>
								<a
									href="/server/{encodeURIComponent(id)}/players/{r.steamId}"
									class="inline-flex items-center gap-2 hover:text-accent hover:underline"
								>
									{#if r.avatar}<img
											src={r.avatar}
											alt=""
											class="h-5 w-5 rounded-[2px] border border-edge"
											referrerpolicy="no-referrer"
										/>{/if}
									<span>{r.name}</span>
								</a>
								<span class="ml-1 font-mono text-[11px] text-mist-600">{r.steamId}</span>
							</td>
							<td class="num">{minutes(r.minutes)}</td>
							<td class="num">{r.matches}</td>
							<td class="num whitespace-nowrap"
								><span class="text-ok">{r.wins}</span> / <span class="text-danger">{r.losses}</span>
								/
								{r.draws}</td
							>
							<td class="num">{r.winRate === null ? '—' : `${r.winRate}%`}</td>
							<td class="num">{fmtNum(r.kills)}</td>
							<td class="num">{fmtNum(r.deaths)}</td>
							<td class="num">{r.kd.toFixed(2)}</td>
							<td class="num">{r.kph.toFixed(1)}</td>
							<td class="num">{fmtNum(r.cash)}</td>
							<td class="whitespace-nowrap text-mist-400">{fmtTime(r.lastSeen)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="12" class="py-8 text-center text-mist-600">
								{#if board.players && board.eligible === 0}
									{board.players} player{board.players === 1 ? ' has' : 's have'} match history here,
									but none with {minutes(board.minMinutes)} of it yet. Lower the floor.
								{:else if search}
									Nobody on the board matches “{search}”.
								{:else}
									No matches recorded yet. The poller writes a row per player per match as it
									samples; the board fills in as matches end.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			Built from what RCON reports: kills, deaths and cash per connected player, sampled every {board.pollSeconds}s
			and turned into increments so a match spanning several sessions, or a reconnect, still counts.
			A match counts once a player was in it for {board.minPresenceMinutes} minutes; win rate needs {board.minDecided}
			decided matches; ties share a rank. Weapons and vehicles are not exposed by the game server.
		</p>
	</div>
{:else}
	<div class="panel text-mist-600">Loading…</div>
{/if}

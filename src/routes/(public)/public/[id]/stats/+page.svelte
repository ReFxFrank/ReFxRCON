<script lang="ts">
	import { api, qs } from '$lib/api';
	import { fmtNum, fmtTime } from '$lib/format';
	import type { CareerRange, LeaderboardSort, LeaderboardView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.publicServer.id);
	// The server-rendered board seeds the page; the controls reload it from then on.
	// svelte-ignore state_referenced_locally
	let board = $state<LeaderboardView>(data.board);
	let scope = $state<'server' | 'org'>('server');
	let range = $state<CareerRange>('30d');
	let sort = $state<LeaderboardSort>('kills');
	let min = $state(30);
	let search = $state('');
	let loading = $state(false);
	let first = true;

	async function load() {
		loading = true;
		try {
			board = await api<LeaderboardView>(
				'GET',
				`/api/public/servers/${encodeURIComponent(id)}/leaderboard${qs({ scope, range, sort, min })}`
			);
		} catch {
			/* keep the last board */
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void [id, scope, range, sort, min];
		if (first) {
			first = false;
			return;
		}
		void load();
	});

	const RANGES: { key: CareerRange; label: string }[] = [
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' },
		{ key: '90d', label: '90 days' },
		{ key: 'all', label: 'All time' }
	];
	const FLOORS = [0, 30, 60, 180, 600];
	const COLUMNS: { key: LeaderboardSort; label: string; title: string }[] = [
		{ key: 'minutes', label: 'Playtime', title: 'Time in matches' },
		{ key: 'matches', label: 'Matches', title: 'Matches played for at least five minutes' },
		{ key: 'wins', label: 'W / L / D', title: 'Wins, losses and draws' },
		{ key: 'winRate', label: 'Win %', title: 'Wins over decided matches' },
		{ key: 'kills', label: 'Kills', title: 'Kills' },
		{ key: 'deaths', label: 'Deaths', title: 'Deaths' },
		{ key: 'kd', label: 'K/D', title: 'Kills per death (kills when never died)' },
		{ key: 'kph', label: 'Kills/h', title: 'Kills per hour in matches' }
	];
	const minutes = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return q ? board.rows.filter((r) => r.name.toLowerCase().includes(q)) : board.rows;
	});
</script>

<svelte:head><title>Leaderboard · {data.publicServer.name} · {data.appName}</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-2">
	{#if board.servers.length > 1 || scope === 'org'}
		<div class="join">
			<button
				class="btn btn-sm {scope === 'server' ? 'btn-primary' : ''}"
				onclick={() => (scope = 'server')}>This server</button
			>
			<button
				class="btn btn-sm {scope === 'org' ? 'btn-primary' : ''}"
				onclick={() => (scope = 'org')}>{data.publicOrg.name}</button
			>
		</div>
	{/if}
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

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
		<span class="label-sm mb-0">Leaderboard</span>
		<span class="text-[12px] text-mist-600"
			>{fmtNum(board.eligible)} ranked of {fmtNum(board.players)} seen · click a column to rank by it{#if loading}
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
						<td class="num font-display text-[15px] {r.rank <= 3 ? 'text-accent' : ''}">{r.rank}</td
						>
						<td>
							<a
								href="/public/{encodeURIComponent(id)}/players/{r.steamId}"
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
						</td>
						<td class="num">{minutes(r.minutes)}</td>
						<td class="num">{r.matches}</td>
						<td class="num whitespace-nowrap"
							><span class="text-ok">{r.wins}</span> / <span class="text-danger">{r.losses}</span> / {r.draws}</td
						>
						<td class="num">{r.winRate === null ? '—' : `${r.winRate}%`}</td>
						<td class="num">{fmtNum(r.kills)}</td>
						<td class="num">{fmtNum(r.deaths)}</td>
						<td class="num">{r.kd.toFixed(2)}</td>
						<td class="num">{r.kph.toFixed(1)}</td>
						<td class="whitespace-nowrap text-mist-400">{fmtTime(r.lastSeen)}</td>
					</tr>
				{:else}
					<tr>
						<td colspan="11" class="py-8 text-center text-mist-600">
							{#if board.players && board.eligible === 0}
								Nobody has {minutes(board.minMinutes)} in matches yet in this range. Lower the floor.
							{:else if search}
								Nobody on the board matches “{search}”.
							{:else}
								No matches recorded in this range yet.
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="note">
		A match counts once a player was in it for {board.minPresenceMinutes} minutes; win rate needs {board.minDecided}
		decided matches; ties share a rank.
	</p>
</div>

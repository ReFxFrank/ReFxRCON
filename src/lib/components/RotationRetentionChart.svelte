<script lang="ts">
	import type { MapRetention } from '$lib/server/rotation-retention';

	let {
		maps,
		minMatches,
		horizonMinutes,
		label = (m: string) => m,
		view = 'chart'
	}: {
		maps: MapRetention[];
		minMatches: number;
		horizonMinutes: number;
		/** Raw map ids are internal; the page passes mapLabel(catalog, id). */
		label?: (map: string) => string;
		view?: 'chart' | 'table';
	} = $props();

	let hover = $state<number | null>(null);

	const scored = $derived(maps.filter((m) => m.residual !== null));
	const unscored = $derived(maps.filter((m) => m.residual === null));

	/**
	 * Why a map has no number. A map that ran plenty of times but shares no time slot with any
	 * other is a different problem from one that barely ran, and lumping them together hides the
	 * one an operator could actually fix by changing the rotation.
	 */
	const WHY: Record<string, string> = $derived({
		'too-few-matches': `under ${minMatches} matches`,
		'not-comparable':
			'never runs at the same time of day as another map, so its map effect and its time-of-day effect cannot be told apart',
		'nothing-to-compare-with':
			'the only map with enough matches, so there is nothing to score it against'
	});
	const reasons = $derived([
		...new Set(unscored.map((m) => m.withheld).filter(Boolean))
	] as string[]);

	/*
	 * Symmetric domain. A diverging scale whose zero is not centred reads as if one direction
	 * were larger than it is, and the whole point of this chart is the sign.
	 */
	const extent = $derived(
		Math.max(
			0.5,
			...scored.flatMap((m) =>
				// lo95/hi95 are null when the standard error is not estimable; the bar is still
				// drawn, so only the values that exist may size the axis. Math.abs(null) is 0,
				// which would quietly shrink it.
				[m.residual, m.lo95, m.hi95].filter((v): v is number => v !== null).map(Math.abs)
			)
		)
	);
	/** Position of a value as a percentage across the plot, with zero at the centre. */
	const pos = (v: number) => 50 + (v / (extent * 2)) * 100;
	const fmt = (v: number) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
</script>

{#if !maps.length}
	<div class="py-10 text-center text-mist-600">
		No closed matches with population readings at both ends yet. This needs matches that ran past
		{horizonMinutes} minutes while sampling was up.
	</div>
{:else if view === 'table'}
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Map</th>
					<th class="num">Matches</th>
					<th class="num">Residual</th>
					<th class="num">95% CI</th>
				</tr>
			</thead>
			<tbody>
				{#each maps as m (m.map + (m.experiences ?? ''))}
					<tr>
						<td>
							{label(m.map)}
							{#if m.experiences}<span class="ml-1.5 chip">{m.experiences}</span>{/if}
						</td>
						<td class="num tabular">{m.matches}</td>
						<td class="num tabular">
							{#if m.residual === null}
								<span class="text-mist-600">—</span>
							{:else}
								{fmt(m.residual)}
							{/if}
						</td>
						<td class="num text-mist-400 tabular">
							{#if m.residual === null}
								<span class="text-mist-600">{WHY[m.withheld ?? ''] ?? 'not scored'}</span>
							{:else if m.lo95 === null || m.hi95 === null}
								<span class="text-mist-600">no interval · all on one day</span>
							{:else}
								{fmt(m.lo95)} … {fmt(m.hi95)}
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<div class="relative">
		<!-- Legend: two series-coloured swatches, because colour alone must never carry identity. -->
		<div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 caps text-mist-400">
			<span class="inline-flex items-center gap-1.5">
				<span
					class="inline-block h-2.5 w-2.5 rounded-[2px]"
					style="background:var(--color-chart-bleed)"
				></span>
				loses players
			</span>
			<span class="inline-flex items-center gap-1.5">
				<span
					class="inline-block h-2.5 w-2.5 rounded-[2px]"
					style="background:var(--color-chart-gain)"
				></span>
				holds or gains
			</span>
			<span class="text-mist-600">vs the average map in this rotation · bars are 95% intervals</span
			>
		</div>

		{#each scored as m, i (m.map + (m.experiences ?? ''))}
			{@const v = m.residual as number}
			{@const lo = m.lo95}
			{@const hi = m.hi95}
			{@const bleeds = v < 0}
			{@const inside = Math.abs(pos(v) - 50) > 40}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="grid grid-cols-[minmax(7rem,11rem)_1fr] items-center gap-3 rounded-ctl px-1.5 py-1 transition-colors"
				style={hover === i ? 'background:rgb(125 183 255 / 0.06)' : ''}
				onmouseenter={() => (hover = i)}
				onmouseleave={() => (hover = null)}
			>
				<div class="min-w-0 text-right">
					<div class="truncate text-[13px]" title={label(m.map)}>{label(m.map)}</div>
					<div class="caps text-[10px] text-mist-600">
						{m.matches} matches{#if m.experiences}
							· {m.experiences}{/if}{#if m.lo95 === null}
							·
							<span
								class="text-warn"
								title="Every match for this map fell on one day, so the spread cannot be estimated."
								>no interval</span
							>{/if}
					</div>
				</div>

				<div class="relative h-7">
					<!-- Neutral midpoint: the zero rule the whole chart is read against. -->
					<div
						class="absolute inset-y-0 w-px"
						style="left:50%;background:var(--color-mist-600)"
						aria-hidden="true"
					></div>
					<!--
						95% interval, drawn under the bar so the point estimate stays readable. It is
						absent when the standard error is not estimable -- every match on one day --
						rather than drawn as a zero-width tick, which would read as certainty.
					-->
					{#if lo !== null && hi !== null}
						<div
							class="absolute top-1/2 h-px -translate-y-1/2"
							style="left:{Math.min(pos(lo), pos(hi))}%; width:{Math.abs(
								pos(hi) - pos(lo)
							)}%; background:var(--color-mist-400); opacity:0.55"
							aria-hidden="true"
						></div>
					{/if}
					<!-- The bar: anchored square at zero, rounded at the data end. -->
					<div
						class="absolute top-1/2 h-3.5 -translate-y-1/2"
						style="
							left:{Math.min(50, pos(v))}%;
							width:{Math.abs(pos(v) - 50)}%;
							background:var(--color-chart-{bleeds ? 'bleed' : 'gain'});
							border-radius:{bleeds ? '4px 0 0 4px' : '0 4px 4px 0'};
						"
						role="img"
						aria-label="{label(m.map)}: {fmt(v)} players over {horizonMinutes} minutes versus the
						average map, {lo !== null && hi !== null
							? `95% interval ${fmt(lo)} to ${fmt(hi)}`
							: 'no interval, every match on one day'}, from {m.matches} matches"
					></div>
					<!--
						Direct label, in a text token: the mark carries identity, the text never does.
						A bar that reaches the end of the plot has no room for an outside label, so past
						80% of the half-width the label moves inside the bar instead of colliding with
						the map name.
					-->
					<div
						class="absolute top-1/2 -translate-y-1/2 font-mono text-[11.5px] tabular {inside
							? 'text-ink-950'
							: 'text-mist-100'}"
						style={bleeds
							? inside
								? `left:${pos(v)}%; margin-left:6px`
								: `right:${100 - Math.min(50, pos(v))}%; margin-right:6px`
							: inside
								? `right:${100 - pos(v)}%; margin-right:6px`
								: `left:${Math.max(50, pos(v))}%; margin-left:6px`}
					>
						{fmt(v)}
					</div>
				</div>
			</div>
		{/each}

		{#if unscored.length}
			<div class="mt-3 border-t border-edge pt-3">
				<div class="mb-1.5 caps text-mist-600">Not scored</div>
				<div class="flex flex-wrap gap-1.5">
					{#each unscored as m (m.map + (m.experiences ?? ''))}
						<span class="badge" title={WHY[m.withheld ?? ''] ?? ''}>
							{label(m.map)}
							<span class="text-mist-600">{m.matches}</span>
						</span>
					{/each}
				</div>
				{#each reasons as why (why)}
					<div class="note">{WHY[why]}.</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

/**
 * Rotation retention: which maps bleed players, well enough to change the rotation on.
 *
 * For each match, compare concurrent players at match start against ten minutes in. The raw
 * delta is useless on its own, so this scores each map on what is left after the confounds are
 * removed. The read side only; nothing here writes.
 *
 * The split of work is deliberate. SQL does what needs the database -- windowing matches and
 * pinning the two population readings to the match they belong to. Every statistic lives in
 * `scoreRotationRetention`, which is pure, exported, and covered by rotation-retention.test.ts.
 * No test in this repository can reach Postgres, and a number people will rewrite a map rotation
 * on is not something to ship untested.
 *
 * What it corrects for, and why each one matters:
 *
 *  - Time of day. A map that rotates in at 3am always looks terrible. Matches are bucketed into
 *    weekend-flag x hour-of-day: 48 buckets, not the 168 of a full hour-of-week. Over a 30-day
 *    window 168 leaves many buckets holding a single match, and a bucket of one carries no
 *    information -- its slot effect is fixed exactly by that one row, so the row's residual is
 *    pinned to its map's effect and contributes no variance. That deflates the standard error
 *    while adding nothing to the estimate, which is the worst combination available.
 *
 *  - Headroom. A server at capacity cannot grow, so matches starting above 90% of max_players
 *    are excluded.
 *
 *  - Starting population. Rotation is ordered, so each map has a fixed predecessor and a
 *    systematically different starting population. Population mean-reverts toward its
 *    time-of-day norm, so a map that always follows a popular map shows a negative delta from
 *    reversion alone. `ccuStart` is measured before the map's ten minutes elapse, so
 *    conditioning on it is legitimate; `ccu10` is the outcome and must never be conditioned on.
 *
 *  - The baseline including the map being scored. This is the one that inverts answers. A
 *    per-slot average computed over the same rows being scored pulls toward whichever map
 *    dominates that slot, by exactly (1 - n_map,slot / n_slot). On a rotation where one map
 *    holds half the entries, that is enough to report the second-worst map in the rotation as
 *    above average. Instead the slot and map effects are fitted jointly by back-fitting, and
 *    map effects are centred on the UNWEIGHTED map average so rotation share cannot move the
 *    zero point -- which matters because the point of the number is to then edit the rotation.
 *
 * Two honest limits, surfaced rather than buried:
 *
 *  - Residuals are a within-rotation contrast. They sum to zero across maps by construction, so
 *    they can rank maps against each other but can never say "the whole rotation is the
 *    problem". `grandMeanDelta` carries the absolute level alongside them.
 *
 *  - The confidence interval describes sampling noise, not causation. Anything that varies
 *    systematically with rotation position and is not in the model will produce a stable,
 *    reproducible, entirely spurious ordering.
 */
import { sql } from 'drizzle-orm';
import type { Env } from './env';

/** Window presets, mirroring analytics.ts. Retention needs a longer window than a population chart. */
export type RetentionRange = '7d' | '30d' | '90d';
const RANGE_DAYS: Record<RetentionRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export const parseRetentionRange = (v: string | null): RetentionRange =>
	v === '7d' || v === '90d' ? v : '30d';

/** Group maps alone, or each (map, experiences) pair separately. */
export type Grouping = 'map' | 'map+experiences';
export const parseGrouping = (v: string | null): Grouping =>
	v === 'map+experiences' ? 'map+experiences' : 'map';

/** Minutes into the match at which the second reading is taken. */
export const HORIZON_MINUTES = 10;
/** How long a reading may be hunted for from its nominal instant. */
export const GRAB_MINUTES = 2;
/** A match starting above this share of capacity has no room to grow and is excluded. */
export const HEADROOM = 0.9;
/** Below this many matches a map gets a count and no number. */
export const MIN_MATCHES = 20;
/** The alternating fit stops when no effect moves by more than this. */
const FIT_TOLERANCE = 1e-9;
/** A cap so a pathological input cannot spin. Real rotations settle in well under a hundred. */
const MAX_FIT_PASSES = 500;

/** One candidate match with its two population readings, straight out of SQL. */
export interface RetentionMatch {
	id: number;
	map: string;
	experiences: string | null;
	/** Weekend flag x hour-of-day, 0..47. Computed in SQL under an explicit timezone. */
	slot: number;
	/** Calendar day under the same timezone; the clustering unit for standard errors. */
	day: string;
	/** Players at match start. null when no reachable sample fell in the window. */
	ccuStart: number | null;
	/** Players at HORIZON_MINUTES in. null when no reachable sample fell in the window. */
	ccu10: number | null;
	/** max_players from the same sample as ccuStart. */
	cap: number | null;
}

/** Why a map has no residual. `null` means it has one. */
export type Withheld =
	/** Fewer than MIN_MATCHES matches. */
	| 'too-few-matches'
	/**
	 * This map never shares a time slot with any other scoreable map, so its map effect and its
	 * time-of-day effect cannot be told apart. A map that only ever runs at 04:00 is scored
	 * against nothing.
	 */
	| 'not-comparable'
	/** Fewer than two scoreable maps: a rotation of one has nothing to be above or below. */
	| 'nothing-to-compare-with';

export interface MapRetention {
	/** The map id. Run it through mapLabel() before showing it. */
	map: string;
	/** Present only when grouping by (map, experiences). */
	experiences: string | null;
	matches: number;
	/** Set when `residual` is null, saying which reason applies. */
	withheld: Withheld | null;
	/**
	 * Players gained or lost over the first ten minutes, relative to the average map in this
	 * rotation, after time-of-day and starting population are removed. null below MIN_MATCHES.
	 */
	residual: number | null;
	/**
	 * Day-clustered standard error of `residual`.
	 *
	 * null means NOT ESTIMABLE, which is not the same as small. It happens when every match for
	 * this map fell on one calendar day (one cluster gives nothing to estimate spread from) or
	 * when the residuals have no observed variance at all. `residual` can be non-null while this
	 * is null: the estimate exists, the uncertainty around it does not.
	 */
	se: number | null;
	lo95: number | null;
	hi95: number | null;
}

export interface RotationRetention {
	range: RetentionRange;
	grouping: Grouping;
	windowDays: number;
	minMatches: number;
	timezone: string;
	horizonMinutes: number;
	/** Worst first. Maps below the threshold sort last and carry a count with no residual. */
	maps: MapRetention[];
	/** Matches that survived every filter and fed the fit. */
	eligible: number;
	/**
	 * Mean raw delta over eligible matches. Residuals are zero-sum, so a rotation where every
	 * map bleeds still shows residuals scattered about zero; this is what says so.
	 */
	grandMeanDelta: number | null;
	/**
	 * Why candidate matches were dropped. An empty panel is otherwise indistinguishable from
	 * "no map clears the threshold", and one of these causes is a silent whole-server wipeout:
	 * an RCON build that omits players.max makes the poller record max_players as 0, and every
	 * match then fails the headroom test.
	 */
	excluded: {
		total: number;
		noStartReading: number;
		noHorizonReading: number;
		noCapacity: number;
		atCapacity: number;
	};
}

/** Estimator inputs, so tests can shrink the thresholds instead of generating hundreds of rows. */
export interface ScoreOptions {
	minMatches?: number;
	headroom?: number;
	grouping?: Grouping;
	/**
	 * CAP on alternating-fit passes, not the number run: the fit stops when the effects settle.
	 * Only lower it to prove a test case about non-convergence.
	 */
	passes?: number;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Group key for a row under the chosen grouping. */
const keyOf = (r: { map: string; experiences: string | null }, g: Grouping): string =>
	g === 'map+experiences' ? `${r.map}\u0000${r.experiences ?? ''}` : r.map;

/** Mean of each group, as a Map. */
function meansBy<T>(rows: T[], key: (r: T) => string | number, value: (r: T) => number) {
	const sums = new Map<string | number, { s: number; n: number }>();
	for (const r of rows) {
		const k = key(r);
		const cur = sums.get(k);
		if (cur) {
			cur.s += value(r);
			cur.n++;
		} else sums.set(k, { s: value(r), n: 1 });
	}
	const out = new Map<string | number, number>();
	for (const [k, { s, n }] of sums) out.set(k, s / n);
	return out;
}

/**
 * Ordinary least squares slope of y on x, through the means. Postgres spells this regr_slope();
 * it is reproduced here so the whole estimator can be tested without a database.
 * Returns 0 when x has no variation, which is the same "no correction" answer regr_slope gives
 * as NULL.
 */
export function slope(xs: number[], ys: number[]): number {
	if (xs.length !== ys.length || xs.length < 2) return 0;
	const mx = mean(xs);
	const my = mean(ys);
	let num = 0;
	let den = 0;
	for (let i = 0; i < xs.length; i++) {
		const dx = xs[i] - mx;
		num += dx * (ys[i] - my);
		den += dx * dx;
	}
	return den === 0 ? 0 : num / den;
}

/**
 * Two-sided 97.5% t quantile, by degrees of freedom.
 *
 * Standard errors here are clustered by DAY, and a 30-day window gives about 30 clusters. The
 * usual 1.96 assumes infinitely many. Measured on synthetic rotations, a normal critical value
 * made the null test reject 9-13% of random splits against a nominal 5% -- an estimator that
 * calls identical halves of the same map different one time in eight. t(G-1) is what the
 * cluster-robust literature prescribes below roughly forty clusters, and it brings the measured
 * rejection rate back to nominal.
 */
const T975 = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
	2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
	2.045, 2.042
];
export function t975(df: number): number {
	if (df < 1) return Infinity;
	if (df <= T975.length) return T975[df - 1];
	// Cornish-Fisher expansion; within 0.0001 of the true quantile for df > 30.
	const z = 1.959963985;
	return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/**
 * CR1 cluster-robust standard error of a mean, clustered by day.
 *
 * Consecutive matches share a population wave and largely the same players, so treating each
 * match as an independent observation overstates precision. `centred` holds each observation's
 * residual minus the group mean, keyed by its cluster.
 */
function clusteredSe(centred: Map<string, number>, n: number): { se: number; groups: number } {
	let ss = 0;
	for (const c of centred.values()) ss += c * c;
	const g = centred.size;
	return { se: Math.sqrt((ss * g) / Math.max(g - 1, 1)) / n, groups: g };
}

/** A row that survived every filter, plus the bookkeeping the fit needs. */
interface FitRow {
	map: string;
	experiences: string | null;
	key: string;
	slot: number;
	day: string;
	ccuStart: number;
	delta: number;
}

/** What the fit produces: the rows it kept, one residual each, and why the rest were dropped. */
interface Fit {
	kept: FitRow[];
	resid: number[];
	/** False when the alternating fit hit its pass cap without settling. */
	converged: boolean;
	/** Group keys that cleared the match threshold, and so define the zero point. */
	scoreableKeys: string[];
	grandMeanDelta: number | null;
	excluded: RotationRetention['excluded'];
}

/**
 * Filter, then fit. Shared by the scorer and the null test, which is what lets the null test
 * hold the slot effects, the starting-population slope and every other map fixed while it
 * compares two halves of one map.
 *
 * Filtering lives here rather than in SQL so every exclusion is counted and reportable, and so
 * the thresholds are testable.
 */
function fit(rows: RetentionMatch[], opts: ScoreOptions): Fit {
	const headroom = opts.headroom ?? HEADROOM;
	const grouping = opts.grouping ?? 'map';
	const passes = opts.passes ?? MAX_FIT_PASSES;

	const excluded = {
		total: 0,
		noStartReading: 0,
		noHorizonReading: 0,
		noCapacity: 0,
		atCapacity: 0
	};
	const kept: FitRow[] = [];

	for (const r of rows) {
		if (r.ccuStart === null) {
			excluded.noStartReading++;
			excluded.total++;
			continue;
		}
		if (r.ccu10 === null) {
			excluded.noHorizonReading++;
			excluded.total++;
			continue;
		}
		// The poller coerces a missing players.max to 0 rather than null, so both the null and
		// the zero have to be caught here or the headroom test silently drops every match on a
		// server whose RCON build omits it -- and an empty panel reads as "no map qualifies".
		if (r.cap === null || r.cap <= 0) {
			excluded.noCapacity++;
			excluded.total++;
			continue;
		}
		if (r.ccuStart >= r.cap * headroom) {
			excluded.atCapacity++;
			excluded.total++;
			continue;
		}
		kept.push({
			map: r.map,
			experiences: r.experiences,
			key: keyOf(r, grouping),
			slot: r.slot,
			day: r.day,
			ccuStart: r.ccuStart,
			delta: r.ccu10 - r.ccuStart
		});
	}

	if (!kept.length) {
		return {
			kept,
			resid: [],
			converged: true,
			scoreableKeys: [],
			grandMeanDelta: null,
			excluded
		};
	}

	// --- control for starting population, as a deviation from the slot's own norm --------------
	// Reversion is toward the time-of-day norm, not the global mean, so the covariate is the
	// excess over the slot average rather than over the grand average.
	const slotCcu = meansBy(
		kept,
		(r) => r.slot,
		(r) => r.ccuStart
	);
	const excess = kept.map((r) => r.ccuStart - (slotCcu.get(r.slot) ?? r.ccuStart));
	const g = slope(
		excess,
		kept.map((r) => r.delta)
	);
	const y = kept.map((r, i) => r.delta - g * excess[i]);

	/*
	 * Two-way additive fit, y = mu + slot effect + map effect, by alternating least squares.
	 *
	 * A single pass of per-slot averaging would BE the self-baseline this whole module exists to
	 * avoid, so the two effect sets are alternated until they stop moving. "Until they stop
	 * moving" is load-bearing and a fixed pass count is not enough: on an unbalanced design --
	 * which every real rotation is, because maps do not appear evenly across the clock -- three
	 * passes leaves a large part of the slot effect still charged to the maps. Measured on a
	 * fixture with known truth, three passes reported +1.30 for a map whose true effect was
	 * +0.50, and -3.37 for one whose truth was -2.50. It settles around forty.
	 *
	 * Each pass is O(n) over a few thousand rows, so iterating to a tolerance costs nothing
	 * worth measuring. `passes` is the CAP, not the count.
	 */
	const mu = mean(y);
	const b = new Map<string | number, number>();
	let a = new Map<string | number, number>();
	let converged = false;
	for (let pass = 0; pass < passes; pass++) {
		const nextA = meansBy(
			kept.map((r, i) => ({ r, v: y[i] - mu - (b.get(r.key) ?? 0) })),
			(x) => x.r.slot,
			(x) => x.v
		);
		const nextB = meansBy(
			kept.map((r, i) => ({ r, v: y[i] - mu - (nextA.get(r.slot) ?? 0) })),
			(x) => x.r.key,
			(x) => x.v
		);
		let moved = 0;
		for (const [k, v] of nextA) moved = Math.max(moved, Math.abs(v - (a.get(k) ?? 0)));
		for (const [k, v] of nextB) moved = Math.max(moved, Math.abs(v - (b.get(k) ?? 0)));
		a = nextA;
		b.clear();
		for (const [k, v] of nextB) b.set(k, v);
		if (moved < FIT_TOLERANCE) {
			converged = true;
			break;
		}
	}

	/*
	 * The zero point is the unweighted average map, not the average match: otherwise a map
	 * holding half the rotation drags the reference toward itself and every other map reads high.
	 *
	 * Averaged over the SCOREABLE maps only, though. Sub-threshold matches stay in the fit --
	 * their slot information is worth having -- but a map nobody can act on must not move the
	 * numbers of the maps they can. Measured on a 2,159-match fixture, letting a 12-match map
	 * with a large effect into the reference shifted every other map's residual by 0.86 players,
	 * which is larger than most of the differences the panel exists to show.
	 */
	const minMatches = opts.minMatches ?? MIN_MATCHES;
	const counts = new Map<string, number>();
	for (const r of kept) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
	const scoreableKeys = [...counts.entries()].filter(([, n]) => n >= minMatches).map(([k]) => k);
	const scoreable = scoreableKeys.map((k) => b.get(k) ?? 0);
	const centre = mean(scoreable.length ? scoreable : [...b.values()]);
	const resid = kept.map((r, i) => y[i] - (a.get(r.slot) ?? 0) - mu - centre);

	return {
		kept,
		resid,
		converged,
		scoreableKeys,
		grandMeanDelta: round2(mean(kept.map((r) => r.delta))),
		excluded
	};
}

/**
 * The whole estimator, pure. Takes candidate matches, returns the scored rotation.
 */
export function scoreRotationRetention(
	rows: RetentionMatch[],
	opts: ScoreOptions = {}
): Pick<RotationRetention, 'maps' | 'eligible' | 'grandMeanDelta' | 'excluded'> {
	const minMatches = opts.minMatches ?? MIN_MATCHES;
	const grouping = opts.grouping ?? 'map';
	const f = fit(rows, opts);
	const { kept, resid } = f;

	if (!kept.length) {
		return { maps: [], eligible: 0, grandMeanDelta: null, excluded: f.excluded };
	}

	/*
	 * Which maps can be compared at all.
	 *
	 * The fit decomposes y into a slot effect and a map effect. That decomposition identifies a
	 * map only RELATIVE to maps it shares time slots with, directly or transitively. A map that
	 * only ever runs at 04:00, and is the only thing that runs at 04:00, has its time-of-day
	 * effect and its own effect perfectly confounded: the fit can put all of it in either, and
	 * does. Measured on a fixture, such a map came out at exactly 0.00 against a true effect of
	 * +0.50, with nothing in the output to indicate anything was wrong.
	 *
	 * So: connected components of the bipartite map/slot graph, and a number is withheld from
	 * anything outside the component holding the most matches.
	 */
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let r = x;
		while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as string;
		parent.set(x, r);
		return r;
	};
	const union = (x: string, y2: string) => {
		parent.set(x, parent.get(x) ?? x);
		parent.set(y2, parent.get(y2) ?? y2);
		const rx = find(x);
		const ry = find(y2);
		if (rx !== ry) parent.set(rx, ry);
	};
	for (const r of kept) union(`m:${r.key}`, `s:${r.slot}`);
	const componentMatches = new Map<string, number>();
	for (const r of kept) {
		const c = find(`m:${r.key}`);
		componentMatches.set(c, (componentMatches.get(c) ?? 0) + 1);
	}
	let mainComponent = '';
	let best = -1;
	for (const [c, n] of componentMatches) {
		if (n > best) {
			best = n;
			mainComponent = c;
		}
	}
	const comparable = new Set(f.scoreableKeys.filter((k) => find(`m:${k}`) === mainComponent));

	const groups = new Map<string, { map: string; experiences: string | null; idx: number[] }>();
	kept.forEach((r, i) => {
		const cur = groups.get(r.key);
		if (cur) cur.idx.push(i);
		else groups.set(r.key, { map: r.map, experiences: r.experiences, idx: [i] });
	});

	const maps: MapRetention[] = [];
	for (const [key, grp] of groups) {
		const n = grp.idx.length;
		let withheld: Withheld | null = null;
		if (n < minMatches) withheld = 'too-few-matches';
		else if (!comparable.has(key)) withheld = 'not-comparable';
		else if (comparable.size < 2) withheld = 'nothing-to-compare-with';

		const residual = mean(grp.idx.map((i) => resid[i]));
		let se: number | null = null;
		let half: number | null = null;
		if (!withheld) {
			const byDay = new Map<string, number>();
			for (const i of grp.idx) {
				byDay.set(kept[i].day, (byDay.get(kept[i].day) ?? 0) + (resid[i] - residual));
			}
			const c = clusteredSe(byDay, n);
			const t = t975(c.groups - 1);
			/*
			 * One day-cluster gives nothing to estimate spread from, and the arithmetic says so
			 * loudly if you let it: the single cluster's centred sum is exactly zero, so the
			 * standard error comes out 0 and t(0) is Infinity, whose product is NaN -- which
			 * JSON serialises as null while the residual stays a number. Reporting se = 0 would
			 * be worse still: a claim of infinite precision from one evening's play.
			 */
			if (c.groups >= 2 && c.se > 0 && Number.isFinite(t)) {
				se = c.se;
				half = t * c.se;
			}
		}

		maps.push({
			map: grp.map,
			experiences: grouping === 'map+experiences' ? grp.experiences : null,
			matches: n,
			withheld,
			residual: withheld ? null : round2(residual),
			se: se === null ? null : round2(se),
			lo95: half === null ? null : round2(residual - half),
			hi95: half === null ? null : round2(residual + half)
		});
	}

	// Worst first among maps that cleared the threshold; sub-threshold maps last.
	maps.sort((x, y2) => {
		const xr = x.residual !== null;
		const yr = y2.residual !== null;
		if (xr !== yr) return xr ? -1 : 1;
		if (xr && yr) return (x.residual as number) - (y2.residual as number);
		return y2.matches - x.matches;
	});

	return {
		maps,
		eligible: kept.length,
		grandMeanDelta: f.grandMeanDelta,
		excluded: f.excluded
	};
}

/**
 * The brief's null test, as a function so it can be a unit test rather than a ritual.
 *
 * Splits one map's matches into two pseudo-maps and rescores in ONE pass, holding the slot fit,
 * the starting-population slope and every other map fixed. Re-running the whole estimator on two
 * halves instead would halve n twice over and refit the baseline differently under each half, so
 * a disagreement could not be attributed to the normalisation.
 *
 * The halves must come out statistically indistinguishable. If they do not, the normalisation is
 * broken and the numbers are noise wearing a confidence interval.
 *
 * The difference is judged against its OWN day-clustered standard error, not against
 * sqrt(se_A^2 + se_B^2). The two halves are fitted together, so their residuals are correlated
 * and the independent-sum form is the wrong variance. It is also compared against t(G-1) rather
 * than 1.96, for the same few-clusters reason as the intervals themselves.
 *
 * `split` decides which half a match falls in. It must NOT be derived arithmetically from
 * `matches.id`: rotation is cyclic and ids are sequential, so id parity is perfectly confounded
 * with rotation position and can put a whole map in one half.
 */
export function nullTest(
	rows: RetentionMatch[],
	map: string,
	split: (m: RetentionMatch) => 0 | 1,
	opts: ScoreOptions = {}
): {
	a: { residual: number; matches: number } | null;
	b: { residual: number; matches: number } | null;
	diff: number;
	critical: number;
	passes: boolean;
} {
	const minMatches = opts.minMatches ?? MIN_MATCHES;
	const A = `${map}\u0001A`;
	const B = `${map}\u0001B`;
	const relabelled = rows.map((r) => (r.map === map ? { ...r, map: split(r) ? B : A } : r));
	const f = fit(relabelled, { ...opts, grouping: 'map' });
	const idxA: number[] = [];
	const idxB: number[] = [];
	f.kept.forEach((r, i) => {
		if (r.map === A) idxA.push(i);
		else if (r.map === B) idxB.push(i);
	});
	if (idxA.length < minMatches || idxB.length < minMatches) {
		return {
			a: idxA.length
				? { residual: round2(mean(idxA.map((i) => f.resid[i]))), matches: idxA.length }
				: null,
			b: idxB.length
				? { residual: round2(mean(idxB.map((i) => f.resid[i]))), matches: idxB.length }
				: null,
			diff: NaN,
			critical: NaN,
			passes: false
		};
	}

	const mA = mean(idxA.map((i) => f.resid[i]));
	const mB = mean(idxB.map((i) => f.resid[i]));

	// One cluster per day, carrying that day's contribution to (mean_A - mean_B).
	const byDay = new Map<string, number>();
	const bump = (day: string, v: number) => byDay.set(day, (byDay.get(day) ?? 0) + v);
	for (const i of idxA) bump(f.kept[i].day, (f.resid[i] - mA) / idxA.length);
	for (const i of idxB) bump(f.kept[i].day, -(f.resid[i] - mB) / idxB.length);
	let ss = 0;
	for (const c of byDay.values()) ss += c * c;
	const G = byDay.size;
	const seDiff = Math.sqrt((ss * G) / Math.max(G - 1, 1));

	const diff = Math.abs(mA - mB);
	const critical = t975(G - 1) * seDiff;
	return {
		a: { residual: round2(mA), matches: idxA.length },
		b: { residual: round2(mB), matches: idxB.length },
		diff,
		critical,
		passes: diff <= critical
	};
}

/** Postgres returns counts and aggregates as strings; same coercion analytics.ts uses. */
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Candidate matches with their two edge readings.
 *
 * Every clause here is load-bearing:
 *  - `ended_at IS NOT NULL` -- a live match has no ten-minute mark yet, and prune() deletes on
 *    `ended_at < cutoff`, which NULL never satisfies, so matches abandoned by a poller that
 *    never restarted would otherwise accumulate for ever and keep passing the filter.
 *  - duration >= horizon + grab -- the whole read window has to lie inside the match. Filtering
 *    on the horizon alone leaves a hole: a failed poll near the ten-minute mark pushes the
 *    second reading past a short match's end and into the next map.
 *  - LEAST(ended_at, ...) and `s.map IS NOT DISTINCT FROM m.map` -- started_at is back-derived
 *    as ts - matchSeconds, so it can precede the sample that first saw the match. Without both,
 *    `ts >= started_at ORDER BY ts LIMIT 1` can return the last sample of the PREVIOUS match,
 *    which is exactly the population the metric is trying to attribute.
 *  - `cap` from the SAME sample as ccu_start -- an unbounded forward scan reads max_players from
 *    whenever sampling resumed after an outage, potentially days later.
 *  - `ORDER BY s.ts, s.ctid` -- samples has an index on (server_id, ts) but no unique key, so
 *    LIMIT 1 over duplicate timestamps is otherwise arbitrary and can differ between runs.
 *  - `AT TIME ZONE ${tz}` -- EXTRACT on a timestamptz silently reads the session TimeZone, which
 *    nothing in this codebase sets. psql on a laptop, the container and a managed instance would
 *    each bucket the same row differently.
 */
async function candidates(
	env: Env,
	serverId: string,
	days: number,
	tz: string
): Promise<RetentionMatch[]> {
	const horizon = `${HORIZON_MINUTES} minutes`;
	const grab = `${GRAB_MINUTES} minutes`;
	const rows = await env.db.execute<{
		id: string;
		map: string;
		experiences: string | null;
		slot: number;
		day: string;
		ccu_start: number | null;
		ccu_10: number | null;
		cap: number | null;
	}>(sql`
			WITH m AS (
				SELECT id, server_id, map, experiences, started_at, ended_at
				  FROM matches
				 WHERE server_id = ${serverId}
				   AND map IS NOT NULL AND map <> ''
				   AND started_at >= now() - ${`${days} days`}::interval
				   AND ended_at IS NOT NULL
				   AND ended_at >= started_at + ${horizon}::interval + ${grab}::interval
			)
			SELECT m.id::text AS id, m.map, m.experiences,
			       (EXTRACT(ISODOW FROM (m.started_at AT TIME ZONE ${tz})) >= 6)::int * 24
			         + EXTRACT(HOUR FROM (m.started_at AT TIME ZONE ${tz}))::int AS slot,
			       (m.started_at AT TIME ZONE ${tz})::date::text AS day,
			       a.player_count AS ccu_start, a.max_players AS cap, b.player_count AS ccu_10
			  FROM m
			  LEFT JOIN LATERAL (
			       SELECT s.player_count, s.max_players FROM samples s
			        WHERE s.server_id = m.server_id AND s.ok AND s.player_count IS NOT NULL
			          AND s.ts >= m.started_at
			          AND s.ts < LEAST(m.ended_at, m.started_at + ${grab}::interval)
			          AND s.map IS NOT DISTINCT FROM m.map
			        ORDER BY s.ts, s.ctid LIMIT 1) a ON TRUE
			  LEFT JOIN LATERAL (
			       SELECT s.player_count FROM samples s
			        WHERE s.server_id = m.server_id AND s.ok AND s.player_count IS NOT NULL
			          AND s.ts >= m.started_at + ${horizon}::interval
			          AND s.ts < LEAST(m.ended_at, m.started_at + ${horizon}::interval + ${grab}::interval)
			          AND s.map IS NOT DISTINCT FROM m.map
			        ORDER BY s.ts, s.ctid LIMIT 1) b ON TRUE
			 ORDER BY m.started_at`);

	return rows.map((r) => ({
		id: Number(r.id),
		map: r.map,
		experiences: r.experiences,
		slot: Number(r.slot),
		day: r.day,
		ccuStart: numOrNull(r.ccu_start),
		ccu10: numOrNull(r.ccu_10),
		cap: numOrNull(r.cap)
	}));
}

export async function loadRotationRetention(
	env: Env,
	serverId: string,
	range: RetentionRange,
	grouping: Grouping = 'map'
): Promise<RotationRetention> {
	const windowDays = RANGE_DAYS[range];
	const timezone = 'UTC';
	const rows = await candidates(env, serverId, windowDays, timezone);
	const scored = scoreRotationRetention(rows, { grouping });
	return {
		range,
		grouping,
		windowDays,
		minMatches: MIN_MATCHES,
		timezone,
		horizonMinutes: HORIZON_MINUTES,
		...scored
	};
}

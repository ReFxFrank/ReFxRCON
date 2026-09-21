import { describe, expect, test } from 'bun:test';
import {
	nullTest,
	parseGrouping,
	parseRetentionRange,
	scoreRotationRetention,
	slope,
	type RetentionMatch
} from './rotation-retention';

/**
 * Deterministic generator. Tests must not flake, so there is no Math.random anywhere here:
 * a small LCG gives the same rotation every run, and the numbers in the assertions below were
 * read off that exact stream.
 */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

interface MapSpec {
	map: string;
	/** Share of rotation entries, relative to the other specs. */
	weight: number;
	/** True effect on players gained over ten minutes. */
	effect: number;
}

/**
 * Builds a rotation whose ground truth we know, with the two confounds the metric exists to
 * remove baked in:
 *
 *  - a time-of-day effect, so a map that rotates in off-peak looks bad for reasons of its own
 *  - mean reversion toward the slot norm, so a map following a popular map starts high and
 *    bleeds back down through no fault of its own
 *
 * Maps are laid into a fixed cyclic rotation, weighted, exactly as an ordered rotation runs.
 */
function rotation(specs: MapSpec[], matches: number, seed = 7): RetentionMatch[] {
	const rand = rng(seed);
	// Slot norms: population by hour-of-day, doubled shape for weekend slots.
	const norm = (slot: number) => {
		const hour = slot % 24;
		const weekend = slot >= 24;
		return 8 + 14 * Math.exp(-((hour - 20) ** 2) / 40) + (weekend ? 3 : 0);
	};
	// Time-of-day effect on the delta itself: the server fills in the evening, empties after.
	const slotEffect = (slot: number) => {
		const hour = slot % 24;
		return hour >= 16 && hour < 22 ? 1.6 : hour >= 2 && hour < 10 ? -1.9 : 0.1;
	};

	const wheel: MapSpec[] = [];
	for (const s of specs) for (let i = 0; i < s.weight; i++) wheel.push(s);

	const out: RetentionMatch[] = [];
	// Twenty minutes per match, walked forward from a fixed instant.
	let t = Date.UTC(2026, 6, 1, 0, 0, 0);
	for (let i = 0; i < matches; i++) {
		const spec = wheel[i % wheel.length];
		const at = new Date(t);
		t += 20 * 60_000;
		const hour = at.getUTCHours();
		const isoDow = ((at.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
		const slot = (isoDow >= 6 ? 24 : 0) + hour;

		const n = norm(slot);
		// Start scattered about the slot norm, so `excess` has variation to fit a slope on.
		const ccuStart = Math.max(1, Math.round(n + (rand() - 0.5) * 9));
		const excess = ccuStart - n;
		const delta = spec.effect + slotEffect(slot) - 0.35 * excess + (rand() - 0.5) * 2.2;
		out.push({
			id: i + 1,
			map: spec.map,
			experiences: 'KOTH',
			slot,
			day: at.toISOString().slice(0, 10),
			ccuStart,
			ccu10: Math.max(0, Math.round(ccuStart + delta)),
			cap: 64
		});
	}
	return out;
}

/** The naive estimator the brief proposes: per-slot average over the same rows being scored. */
function naiveResiduals(rows: RetentionMatch[]): Map<string, number> {
	const keep = rows.filter(
		(r) => r.ccuStart !== null && r.ccu10 !== null && r.cap !== null && r.ccuStart < r.cap * 0.9
	);
	const bySlot = new Map<number, number[]>();
	for (const r of keep) {
		const d = (r.ccu10 as number) - (r.ccuStart as number);
		bySlot.set(r.slot, [...(bySlot.get(r.slot) ?? []), d]);
	}
	const expected = new Map<number, number>();
	for (const [s, ds] of bySlot) expected.set(s, ds.reduce((a, b) => a + b, 0) / ds.length);
	const byMap = new Map<string, number[]>();
	for (const r of keep) {
		const d = (r.ccu10 as number) - (r.ccuStart as number) - (expected.get(r.slot) as number);
		byMap.set(r.map, [...(byMap.get(r.map) ?? []), d]);
	}
	const out = new Map<string, number>();
	for (const [m, ds] of byMap) out.set(m, ds.reduce((a, b) => a + b, 0) / ds.length);
	return out;
}

describe('parseRetentionRange', () => {
	test('defaults to 30 days', () => {
		expect(parseRetentionRange(null)).toBe('30d');
		expect(parseRetentionRange('nonsense')).toBe('30d');
	});
	test('accepts the other two windows', () => {
		expect(parseRetentionRange('7d')).toBe('7d');
		expect(parseRetentionRange('90d')).toBe('90d');
	});
});

describe('parseGrouping', () => {
	test('defaults to map alone', () => {
		expect(parseGrouping(null)).toBe('map');
		expect(parseGrouping('experiences')).toBe('map');
	});
	test('accepts the pair split', () => {
		expect(parseGrouping('map+experiences')).toBe('map+experiences');
	});
});

describe('slope', () => {
	test('recovers a known slope', () => {
		expect(slope([1, 2, 3, 4], [3, 5, 7, 9])).toBeCloseTo(2, 10);
	});
	test('no variation in x means no correction, not a divide by zero', () => {
		expect(slope([5, 5, 5], [1, 2, 3])).toBe(0);
	});
	test('too few points to fit anything', () => {
		expect(slope([1], [1])).toBe(0);
		expect(slope([], [])).toBe(0);
	});
});

describe('scoreRotationRetention — exclusions', () => {
	const base: RetentionMatch = {
		id: 1,
		map: 'Kavkazi',
		experiences: 'KOTH',
		slot: 20,
		day: '2026-07-01',
		ccuStart: 10,
		ccu10: 12,
		cap: 32
	};

	test('a match with no reading at the start is excluded and counted', () => {
		const r = scoreRotationRetention([{ ...base, ccuStart: null }]);
		expect(r.eligible).toBe(0);
		expect(r.excluded.noStartReading).toBe(1);
		expect(r.excluded.total).toBe(1);
	});

	test('a match with no reading at ten minutes is excluded and counted', () => {
		const r = scoreRotationRetention([{ ...base, ccu10: null }]);
		expect(r.excluded.noHorizonReading).toBe(1);
	});

	test('a full server is excluded: it has no room to grow', () => {
		const r = scoreRotationRetention([{ ...base, ccuStart: 30, cap: 32 }]);
		expect(r.excluded.atCapacity).toBe(1);
		expect(r.eligible).toBe(0);
	});

	test('a server just under the headroom line is kept', () => {
		const r = scoreRotationRetention([{ ...base, ccuStart: 28, cap: 32 }]);
		expect(r.eligible).toBe(1);
		expect(r.excluded.total).toBe(0);
	});

	/*
	 * The poller coerces a missing players.max to 0 rather than null, so on an RCON build that
	 * omits it every match fails `ccuStart < cap * 0.9` and the panel goes silently empty. That
	 * is indistinguishable from "no map clears the threshold" unless the reason is counted.
	 */
	test('capacity of zero is counted as missing capacity, not as a full server', () => {
		const r = scoreRotationRetention([{ ...base, cap: 0 }]);
		expect(r.excluded.noCapacity).toBe(1);
		expect(r.excluded.atCapacity).toBe(0);
		expect(r.eligible).toBe(0);
	});

	test('no eligible matches yields no maps and no grand mean, not a zero', () => {
		const r = scoreRotationRetention([{ ...base, cap: 0 }]);
		expect(r.maps).toEqual([]);
		expect(r.grandMeanDelta).toBeNull();
	});
});

describe('scoreRotationRetention — the match threshold', () => {
	test('a map below the threshold shows its count and no residual', () => {
		const rows = rotation(
			[
				{ map: 'Kavkazi', weight: 9, effect: 0 },
				{ map: 'Rarity', weight: 1, effect: 0 }
			],
			200
		);
		const r = scoreRotationRetention(rows, { minMatches: 20 });
		const rare = r.maps.find((m) => m.map === 'Rarity');
		expect(rare).toBeDefined();
		expect(rare!.matches).toBe(20);
		const common = r.maps.find((m) => m.map === 'Kavkazi');
		expect(common!.residual).not.toBeNull();
	});

	test('sub-threshold maps sort last, below every map that has a number', () => {
		const rows = rotation(
			[
				{ map: 'Kavkazi', weight: 9, effect: -4 },
				{ map: 'Rarity', weight: 1, effect: -9 }
			],
			120
		);
		const r = scoreRotationRetention(rows, { minMatches: 20 });
		// Rarity is by far the worst map, but with 12 matches it must not outrank anything.
		expect(r.maps[r.maps.length - 1].map).toBe('Rarity');
		expect(r.maps[r.maps.length - 1].residual).toBeNull();
		expect(r.maps[r.maps.length - 1].matches).toBe(12);
	});
});

describe('scoreRotationRetention — a map nobody can score must not move the ones they can', () => {
	/*
	 * Sub-threshold matches stay in the fit, because their slot information is worth having.
	 * But the reported zero is "the average scoreable map", not "the average map that happened
	 * to appear": a map that ran twelve times must not re-baseline the maps with three hundred.
	 * Measured on the seeded fixture, letting a 12-match map with a -6 effect into the reference
	 * shifted every other residual by 0.86 players -- more than most differences worth acting on.
	 */
	const specs: MapSpec[] = [
		{ map: 'Kavkazi', weight: 3, effect: 0 },
		{ map: 'Europe', weight: 1, effect: 0.5 },
		{ map: 'NorthAmerica', weight: 1, effect: -1.5 },
		{ map: 'Bakurani', weight: 1, effect: 1 },
		{ map: 'Ozeti', weight: 1, effect: -4 }
	];
	const rows = rotation(specs, 900);
	// The same rotation with a wildly bad map bolted on, far too rarely to be scored.
	const withRare: RetentionMatch[] = [
		...rows,
		...rows.slice(0, 12).map((r, i) => ({
			...r,
			id: 100_000 + i,
			map: 'Verdun_Night',
			ccu10: (r.ccu10 as number) - 6
		}))
	];

	test('the rare map is listed with its count and no residual', () => {
		const r = scoreRotationRetention(withRare, { minMatches: 20 });
		const rare = r.maps.find((m) => m.map === 'Verdun_Night')!;
		expect(rare.matches).toBe(12);
		expect(rare.residual).toBeNull();
		expect(rare.se).toBeNull();
		expect(rare.lo95).toBeNull();
	});

	test('every scoreable map keeps the residual it had before the rare map appeared', () => {
		const before = scoreRotationRetention(rows, { minMatches: 20 });
		const after = scoreRotationRetention(withRare, { minMatches: 20 });
		for (const m of before.maps) {
			const a = after.maps.find((x) => x.map === m.map)!;
			expect(Math.abs((a.residual as number) - (m.residual as number))).toBeLessThan(0.1);
		}
	});
});

describe('scoreRotationRetention — the synthetic test', () => {
	/*
	 * The brief's acceptance criterion: inject fixtures for a map that reliably sheds players
	 * and confirm it ranks last. "Last" in the panel's order is worst-first, so it is maps[0].
	 */
	const specs: MapSpec[] = [
		{ map: 'Kavkazi', weight: 1, effect: 0 },
		{ map: 'Europe', weight: 1, effect: 0 },
		{ map: 'NorthAmerica', weight: 1, effect: 0 },
		{ map: 'Bakurani', weight: 1, effect: 0 },
		{ map: 'Ozeti', weight: 1, effect: -4 }
	];
	const rows = rotation(specs, 600);
	const scored = scoreRotationRetention(rows, { minMatches: 20 });

	test('the map that sheds players ranks worst', () => {
		expect(scored.maps[0].map).toBe('Ozeti');
	});

	test('its residual is close to the truth', () => {
		// Truth is -4 against an unweighted map average of -0.8, so the target is -3.2.
		expect(scored.maps[0].residual!).toBeGreaterThan(-3.7);
		expect(scored.maps[0].residual!).toBeLessThan(-2.7);
	});

	test('its interval excludes zero, and the innocent maps overlap zero', () => {
		expect(scored.maps[0].hi95!).toBeLessThan(0);
		for (const m of scored.maps.slice(1)) {
			expect(m.lo95!).toBeLessThan(m.residual! + 0.01);
			expect(m.hi95!).toBeGreaterThan(0);
		}
	});

	test('every eligible match is accounted for', () => {
		const total = scored.maps.reduce((a, m) => a + m.matches, 0);
		expect(total).toBe(scored.eligible);
		expect(scored.eligible + scored.excluded.total).toBe(rows.length);
	});
});

describe('scoreRotationRetention — the baseline must not include the map being scored', () => {
	/*
	 * This is the failure that inverts answers. A per-slot average computed over the same rows
	 * being scored is pulled toward whichever map dominates the slot, by exactly
	 * (1 - n_map,slot / n_slot). Give one map half the rotation and the second-worst map in it
	 * comes out ABOVE average -- so rotating it in MORE on the strength of the number makes the
	 * server worse. The jointly-fitted estimator has to survive the same data.
	 */
	const specs: MapSpec[] = [
		{ map: 'Kokan', weight: 5, effect: -3 },
		{ map: 'Dustbowl', weight: 1, effect: -1.5 },
		{ map: 'Bridge', weight: 1, effect: 0 },
		{ map: 'Harju', weight: 1, effect: 0 },
		{ map: 'Narva', weight: 2, effect: 1 }
	];
	const rows = rotation(specs, 900, 11);
	const scored = scoreRotationRetention(rows, { minMatches: 20 });
	const naive = naiveResiduals(rows);
	const by = (m: string) => scored.maps.find((x) => x.map === m)!;

	// Truth, centred on the unweighted map average of -0.7, which is the reference the estimator
	// reports against: Kokan -2.30, Dustbowl -0.80, Bridge +0.70, Harju +0.70, Narva +1.70.
	const target: Record<string, number> = {
		Kokan: -2.3,
		Dustbowl: -0.8,
		Bridge: 0.7,
		Harju: 0.7,
		Narva: 1.7
	};

	test('the naive per-slot baseline is wrong about every map', () => {
		// Regression guard. If this stops holding, the fixture no longer contains the confound
		// and the comparison below proves nothing.
		for (const m of Object.keys(target)) {
			expect(Math.abs(naive.get(m)! - target[m])).toBeGreaterThan(0.5);
		}
	});

	test('the naive baseline all but erases the second-worst map', () => {
		// The damning one: Dustbowl truly sits 0.8 players below the average map, and the naive
		// estimator reports it within a tenth of zero -- a map you would never think to touch.
		expect(Math.abs(naive.get('Dustbowl')!)).toBeLessThan(0.2);
	});

	test('the fitted estimator recovers every map to within a tenth of a player', () => {
		for (const m of Object.keys(target)) {
			expect(Math.abs(by(m).residual! - target[m])).toBeLessThan(0.15);
		}
	});

	test('the ordering matches the truth end to end', () => {
		expect(scored.maps.map((m) => m.map)).toEqual([
			'Kokan',
			'Dustbowl',
			'Bridge',
			'Harju',
			'Narva'
		]);
	});

	test('the dominant map is not flattered by holding half the rotation', () => {
		// The naive baseline attenuates it toward zero by (1 - n_map,slot / n_slot), which for a
		// map holding half the rotation is a large discount on its own badness.
		expect(naive.get('Kokan')!).toBeGreaterThan(by('Kokan').residual! + 0.5);
		expect(by('Kokan').residual!).toBeLessThan(-1.9);
	});
});

describe('scoreRotationRetention — the absolute level is not thrown away', () => {
	test('a rotation where every map bleeds still reports residuals about zero', () => {
		const rows = rotation(
			[
				{ map: 'A', weight: 1, effect: -5 },
				{ map: 'B', weight: 1, effect: -5 },
				{ map: 'C', weight: 1, effect: -5 }
			],
			300
		);
		const r = scoreRotationRetention(rows, { minMatches: 20 });
		// Residuals are a within-rotation contrast; they cannot say "all of them".
		for (const m of r.maps) expect(Math.abs(m.residual!)).toBeLessThan(0.6);
		// The grand mean is what says it. Reversion and the slot mix move it a little off -5.
		expect(r.grandMeanDelta!).toBeLessThan(-3.5);
	});
});

describe('nullTest', () => {
	/*
	 * The brief's other acceptance criterion: split one map's matches in half and score each
	 * half. They must come out statistically indistinguishable. If they do not, the
	 * normalisation is broken and the numbers are noise wearing a confidence interval.
	 *
	 * The split must not be derived arithmetically from the match id: rotation is cyclic and ids
	 * are sequential, so id parity is perfectly confounded with rotation position and would put
	 * a whole map in one half.
	 */
	const specs: MapSpec[] = [
		{ map: 'Kavkazi', weight: 1, effect: 0 },
		{ map: 'Europe', weight: 1, effect: 0 },
		{ map: 'Ozeti', weight: 1, effect: -3 },
		{ map: 'Bakurani', weight: 1, effect: 1 }
	];
	// 2160 matches at twenty minutes each is 30 days, the panel's default window.
	const rows = rotation(specs, 2160);

	/** A hashed split, seeded, so it is random with respect to rotation position but repeatable. */
	const splitter =
		(seed: number) =>
		(m: RetentionMatch): 0 | 1 => {
			let h = seed >>> 0;
			const s = `${m.id}:${seed}`;
			for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0) >>> 0;
			return ((h >>> 7) & 1) as 0 | 1;
		};

	test('the two halves of a neutral map are indistinguishable', () => {
		const r = nullTest(rows, 'Kavkazi', splitter(1), { minMatches: 20 });
		expect(r.a).not.toBeNull();
		expect(r.b).not.toBeNull();
		expect(r.passes).toBe(true);
	});

	test('the two halves of the bleeding map are indistinguishable too', () => {
		// A real effect must appear in BOTH halves; the null test checks the error bars, not
		// whether the effect exists.
		const r = nullTest(rows, 'Ozeti', splitter(2), { minMatches: 20 });
		expect(r.passes).toBe(true);
		expect(r.a!.residual).toBeLessThan(-1);
		expect(r.b!.residual).toBeLessThan(-1);
	});

	/*
	 * The test that decides whether any of the others mean anything. A 95% interval must reject
	 * identical halves about 1 time in 20 -- no more, or it cries wolf; no less, or it is a
	 * rubber stamp that would pass whatever the estimator did.
	 *
	 * This is what caught the real bug here. Standard errors are clustered by day and a 30-day
	 * window gives about 30 clusters, so the usual 1.96 critical value is too tight: it rejected
	 * 9-13% depending on the map, and unevenly, which is the signature of a variance model that
	 * is wrong rather than merely noisy. Judging against t(G-1), and clustering the DIFFERENCE
	 * rather than assuming the two halves are independent, brings it to 3.5-5%.
	 */
	test('it is calibrated: identical halves are rejected about 1 time in 20, not 1 in 8', () => {
		for (const map of ['Kavkazi', 'Europe', 'Ozeti', 'Bakurani']) {
			let failures = 0;
			for (let seed = 1; seed <= 200; seed++) {
				if (!nullTest(rows, map, splitter(seed), { minMatches: 20 }).passes) failures++;
			}
			expect(failures).toBeGreaterThan(0); // not a rubber stamp
			expect(failures).toBeLessThanOrEqual(20); // 10%, generous around a nominal 5%
		}
	});

	test('judging against the per-map standard errors instead would be a rubber stamp', () => {
		// The brief's acceptance criterion says the halves must be "statistically
		// indistinguishable" without saying against what. Against the per-match spread rather
		// than the standard error of the mean, nothing is ever distinguishable and the test
		// proves nothing at all.
		let rejectionsAgainstSpread = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const r = nullTest(rows, 'Kavkazi', splitter(seed), { minMatches: 20 });
			// Per-match residual spread here is around 0.7 players; the mean's SE is ~0.03.
			if (r.diff > 0.7) rejectionsAgainstSpread++;
		}
		expect(rejectionsAgainstSpread).toBe(0);
	});

	test('a split that does carry a real difference is detected', () => {
		// Shift one half by a large amount and the test must fail, or it proves nothing.
		const rigged = rows.map((r) =>
			r.map === 'Kavkazi' && r.id % 2 === 0 ? { ...r, ccu10: (r.ccu10 as number) - 6 } : r
		);
		const r = nullTest(rigged, 'Kavkazi', (m) => (m.id % 2 === 0 ? 1 : 0) as 0 | 1, {
			minMatches: 20
		});
		expect(r.passes).toBe(false);
	});

	test('a map with too few matches cannot be tested, and says so', () => {
		const r = nullTest(rows, 'Kavkazi', splitter(1), { minMatches: 500 });
		expect(r.passes).toBe(false);
		expect(Number.isNaN(r.diff)).toBe(true);
	});
});

describe('scoreRotationRetention — grouping by (map, experiences)', () => {
	test('one map running two experiences splits into two rows', () => {
		const rows = rotation([{ map: 'Kavkazi', weight: 1, effect: 0 }], 200).map((r, i) => ({
			...r,
			experiences: i % 2 ? 'KOTH' : 'Infantry'
		}));
		const grouped = scoreRotationRetention(rows, {
			minMatches: 20,
			grouping: 'map+experiences'
		});
		expect(grouped.maps).toHaveLength(2);
		expect(grouped.maps.map((m) => m.experiences).sort()).toEqual(['Infantry', 'KOTH']);
		const plain = scoreRotationRetention(rows, { minMatches: 20 });
		expect(plain.maps).toHaveLength(1);
		expect(plain.maps[0].experiences).toBeNull();
	});
});

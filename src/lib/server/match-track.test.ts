import { describe, expect, test } from 'bun:test';
import {
	baselineAfterGap,
	closingScores,
	counterDelta,
	matchBoundary,
	matchOutcome,
	resultFor
} from './match-track';

describe('counterDelta', () => {
	test('growth since the last reading', () => {
		expect(counterDelta(12, 10)).toBe(2);
		expect(counterDelta(10, 10)).toBe(0);
	});
	test('first reading counts everything so far', () => {
		expect(counterDelta(7, null)).toBe(7);
		expect(counterDelta(7, undefined)).toBe(7);
	});
	test('a reset (new match or reconnect) counts the new value in full', () => {
		expect(counterDelta(3, 40)).toBe(3);
		expect(counterDelta(0, 40)).toBe(0);
	});
	test('garbage never subtracts', () => {
		expect(counterDelta(-1, 5)).toBe(0);
		expect(counterDelta(Number.NaN, 5)).toBe(0);
	});
});

describe('matchOutcome', () => {
	test('top score wins', () => {
		expect(
			matchOutcome([
				{ name: 'RED', score: 900 },
				{ name: 'BLU', score: 1000 },
				{ name: 'GRN', score: 10 }
			])
		).toEqual({ winner: 'BLU', draw: false, scored: true });
	});
	test('a tie at the top is a draw', () => {
		expect(
			matchOutcome([
				{ name: 'RED', score: 500 },
				{ name: 'BLU', score: 500 },
				{ name: 'GRN', score: 100 }
			])
		).toEqual({ winner: null, draw: true, scored: true });
	});
	test('nobody scored: no outcome', () => {
		expect(matchOutcome([{ name: 'RED', score: 0 }])).toEqual({
			winner: null,
			draw: false,
			scored: false
		});
		expect(matchOutcome([])).toEqual({ winner: null, draw: false, scored: false });
		expect(matchOutcome(null)).toEqual({ winner: null, draw: false, scored: false });
	});
	test('a single faction that scored still wins', () => {
		expect(matchOutcome([{ name: 'RED', score: 1 }]).winner).toBe('RED');
	});
});

describe('resultFor', () => {
	const won = matchOutcome([
		{ name: 'RED', score: 1000 },
		{ name: 'BLU', score: 400 }
	]);
	test('win, loss, draw', () => {
		expect(resultFor('RED', won)).toBe('win');
		expect(resultFor('BLU', won)).toBe('loss');
		expect(resultFor('GRN', won)).toBe('loss');
		expect(
			resultFor(
				'BLU',
				matchOutcome([
					{ name: 'RED', score: 5 },
					{ name: 'BLU', score: 5 }
				])
			)
		).toBe('draw');
	});
	test('no faction or no outcome: nothing', () => {
		expect(resultFor(null, won)).toBeNull();
		expect(resultFor('', won)).toBeNull();
		expect(resultFor('RED', matchOutcome([]))).toBeNull();
	});
});

describe('closingScores', () => {
	const scores = [{ name: 'RED', score: 5 }];
	test('the previous sample closes a restart or map change', () => {
		expect(closingScores('restarted', scores)).toBe(scores);
		expect(closingScores('map', scores)).toBe(scores);
	});
	test('nothing after an outage, and nothing on a fresh process', () => {
		expect(closingScores('stale', scores)).toBeNull();
		expect(closingScores('map', null)).toBeNull();
		expect(closingScores('restarted', [])).toBeNull();
	});
});

describe('baselineAfterGap', () => {
	const start = new Date('2026-09-14T12:00:00Z');
	test('a session the outage closed during this match carries its counters forward', () => {
		expect(baselineAfterGap(new Date('2026-09-14T12:10:00Z'), 20, start)).toBe(20);
	});
	test('a session from before the match, or no session, carries nothing', () => {
		expect(baselineAfterGap(new Date('2026-09-14T11:50:00Z'), 20, start)).toBeNull();
		expect(baselineAfterGap(null, 20, start)).toBeNull();
		expect(baselineAfterGap(new Date('2026-09-14T12:10:00Z'), null, start)).toBeNull();
		expect(baselineAfterGap(new Date('2026-09-14T12:10:00Z'), 20, null)).toBeNull();
	});
});

describe('matchBoundary', () => {
	const ts = new Date('2026-09-14T12:00:00Z');
	const current = { map: 'Europe', startedAt: new Date(ts.getTime() - 40 * 60_000) };
	test('first match ever', () => {
		expect(
			matchBoundary({ matchSeconds: 100, lastMatchSeconds: null, current: null, map: 'Europe', ts })
		).toBeNull();
	});
	test('clock moving forward on the same map: still the same match', () => {
		expect(
			matchBoundary({ matchSeconds: 2420, lastMatchSeconds: 2400, current, map: 'Europe', ts })
		).toBeNull();
	});
	test('clock went backwards: restart', () => {
		expect(
			matchBoundary({ matchSeconds: 15, lastMatchSeconds: 2400, current, map: 'Europe', ts })
		).toBe('restarted');
	});
	test('a small backwards jitter is not a restart', () => {
		expect(
			matchBoundary({ matchSeconds: 2390, lastMatchSeconds: 2400, current, map: 'Europe', ts })
		).toBeNull();
	});
	test('map changed', () => {
		expect(
			matchBoundary({ matchSeconds: 2420, lastMatchSeconds: 2400, current, map: 'Kavkazi', ts })
		).toBe('map');
	});
	test('after an outage the clock says the open match is long gone', () => {
		// The open match started 40 min ago; the server says this one started 5 min ago.
		expect(
			matchBoundary({ matchSeconds: 300, lastMatchSeconds: null, current, map: 'Europe', ts })
		).toBe('stale');
	});
	test('after a poller restart mid-match the open match is kept', () => {
		expect(
			matchBoundary({ matchSeconds: 2400, lastMatchSeconds: null, current, map: 'Europe', ts })
		).toBeNull();
	});
	test('no clock at all: only the map can tell', () => {
		expect(
			matchBoundary({ matchSeconds: null, lastMatchSeconds: null, current, map: 'Europe', ts })
		).toBeNull();
		expect(
			matchBoundary({ matchSeconds: null, lastMatchSeconds: null, current, map: 'Kavkazi', ts })
		).toBe('map');
	});
});

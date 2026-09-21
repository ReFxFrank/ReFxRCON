// Per-match player statistics out of RCON's running counters. The game reports each connected
// player's kills and deaths as counters that start at zero when they join and again when a match
// starts, so storing the raw value would lose the earlier part of a session that spans two matches
// and of a player who reconnects. These helpers turn consecutive readings into increments, decide
// when a new match began, and hand out win / loss / draw. Pure functions; the poller applies them.

export interface Score {
	name: string;
	score: number;
}

/**
 * How much a counter grew since the previous reading. A drop means the counter was reset (a new
 * match, or the player reconnected), so everything it shows now happened since the reset.
 */
export function counterDelta(now: number, last: number | null | undefined): number {
	if (!Number.isFinite(now) || now < 0) return 0;
	if (last === null || last === undefined || now < last) return now;
	return now - last;
}

export type MatchResult = 'win' | 'loss' | 'draw';

export interface Outcome {
	/** the faction with the highest score, or null on a draw or when nobody scored */
	winner: string | null;
	draw: boolean;
	/** at least one faction scored: an empty server rolling through its rotation has no outcome */
	scored: boolean;
}

/** Who won, from the last scores seen before the match ended. */
export function matchOutcome(scores: Score[] | null | undefined): Outcome {
	const sorted = [...(scores ?? [])].sort((a, b) => b.score - a.score);
	const top = sorted[0];
	if (!top || !(top.score > 0)) return { winner: null, draw: false, scored: false };
	const draw = sorted.length > 1 && sorted[1].score === top.score;
	return { winner: draw ? null : top.name, draw, scored: true };
}

/** A player's result, from the faction they last played for in that match. */
export function resultFor(faction: string | null | undefined, o: Outcome): MatchResult | null {
	if (!o.scored || !faction) return null;
	if (o.draw) return 'draw';
	return faction === o.winner ? 'win' : 'loss';
}

/**
 * The scores a match closes with: the previous sample's. After an outage (`stale`) they belong
 * to some other match, and on a fresh process there are none yet; a match closed on this sample's
 * scores would hand every player a result from the *next* match, so those close with no outcome.
 */
export function closingScores(boundary: Boundary, lastScores: Score[] | null): Score[] | null {
	return boundary === 'stale' || !lastScores?.length ? null : lastScores;
}

/**
 * The counter baseline for a player who has no open session but did have one that an outage
 * closed during the match still running: their counters may have kept going, so the last raw
 * reading is the baseline (a genuine reconnect reads lower and counterDelta counts it from zero).
 * Outside the running match there is nothing to carry over.
 */
export function baselineAfterGap(
	lastLeftAt: Date | null | undefined,
	lastRaw: number | null | undefined,
	matchStartedAt: Date | null | undefined
): number | null {
	if (!lastLeftAt || !matchStartedAt || lastRaw === null || lastRaw === undefined) return null;
	return lastLeftAt.getTime() >= matchStartedAt.getTime() ? lastRaw : null;
}

/** The match clock may jitter by a poll interval; anything further back is a restart. */
const RESTART_SLACK_S = 30;
/** After an outage the clock alone has to say whether the match we knew is still running. */
const STALE_SLACK_MS = 10 * 60_000;

export type Boundary = 'restarted' | 'map' | 'stale';

/**
 * Does this sample begin a new match? `restarted`: the clock went backwards (restart, rotation
 * advance). `map`: the map differs from the open match's. `stale`: the first sample after a poller
 * start or an outage, and the clock says the match started well after the one still open, so a
 * match (or more) went by unseen.
 */
export function matchBoundary(input: {
	matchSeconds: number | null;
	lastMatchSeconds: number | null;
	current: { map: string | null; startedAt: Date } | null;
	map: string;
	ts: Date;
}): Boundary | null {
	const { matchSeconds: secs, lastMatchSeconds: last, current } = input;
	if (secs !== null && last !== null && secs < last - RESTART_SLACK_S) return 'restarted';
	if (!current) return null;
	if (current.map !== input.map) return 'map';
	if (secs !== null && last === null) {
		const estimatedStart = input.ts.getTime() - secs * 1000;
		if (estimatedStart - current.startedAt.getTime() > STALE_SLACK_MS) return 'stale';
	}
	return null;
}

// Read side of player_match_stats: the organisation leaderboard and a player's career. Both run
// over the same aggregate (one row per player from their match rows), so a rank shown on a dossier
// is the same rank the board would show.
import { sql, type SQL } from 'drizzle-orm';
import type { Env } from './env';
import { pollSeconds } from './env';
import { int } from './http';
import type { MatchResult } from './match-track';
import type {
	CareerMatch,
	CareerRange,
	CareerView,
	LeaderboardRow,
	LeaderboardSort,
	LeaderboardView
} from '$lib/types';

const RANGE_MS: Record<Exclude<CareerRange, 'all'>, number> = {
	'7d': 7 * 86400000,
	'30d': 30 * 86400000,
	'90d': 90 * 86400000
};
export const parseCareerRange = (v: string | null): CareerRange =>
	v === '7d' || v === '30d' || v === '90d' ? v : 'all';
const rangeFrom = (range: CareerRange): Date =>
	range === 'all' ? new Date(0) : new Date(Date.now() - RANGE_MS[range]);

/** A match only counts as played (and its result only counts) after this long in it. */
export const MIN_PRESENCE_S = 300;
/** Win rate needs this many decided matches before it means anything. */
export const MIN_DECIDED = 3;
/** Default playtime floor before a player appears on the board. */
export const DEFAULT_MIN_MINUTES = 30;
const MAX_ROWS = 200;

const SORTS: Record<LeaderboardSort, string> = {
	kills: 'r.kills DESC',
	kd: 'r.kd DESC',
	kph: 'r.kph DESC',
	minutes: 'r.minutes DESC',
	matches: 'r.matches DESC',
	wins: 'r.wins DESC',
	winRate: 'r.win_rate DESC NULLS LAST',
	deaths: 'r.deaths DESC',
	cash: 'r.cash DESC'
};
export const parseSort = (v: string | null): LeaderboardSort =>
	v && Object.hasOwn(SORTS, v) ? (v as LeaderboardSort) : 'kills';
export const parseMinMinutes = (v: string | null): number =>
	int(v, DEFAULT_MIN_MINUTES, 0, 100_000);

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoOf = (v: unknown): string | null =>
	v === null || v === undefined
		? null
		: v instanceof Date
			? v.toISOString()
			: new Date(String(v)).toISOString();
const round = (v: number, places: number): number => {
	const f = 10 ** places;
	return Math.round(v * f) / f;
};

type AggRow = {
	steamId: string;
	name: string;
	avatar: string | null;
	matches: string;
	wins: string;
	losses: string;
	draws: string;
	kills: string;
	deaths: string;
	minutes: string;
	bestKills: string;
	cash: string;
	kd: string;
	kph: string;
	winRate: string | null;
	lastSeen: Date;
	eligible: string;
};

/**
 * The common table expressions every board query starts from: `agg` sums each player's match
 * rows, `latest` carries their last name and cash, `ranked` joins the two, derives the ratios and
 * applies the playtime floor. `r.eligible` is how many players cleared the floor.
 */
function boardCte(ids: string[], from: Date, poll: number, minMinutes: number): SQL {
	const played = sql`EXTRACT(EPOCH FROM (last_seen - first_seen)) + ${poll} >= ${MIN_PRESENCE_S}`;
	return sql`
		agg AS (
			SELECT steam_id,
			       COUNT(*) FILTER (WHERE ${played}) AS matches,
			       COUNT(*) FILTER (WHERE ${played} AND result = 'win') AS wins,
			       COUNT(*) FILTER (WHERE ${played} AND result = 'loss') AS losses,
			       COUNT(*) FILTER (WHERE ${played} AND result = 'draw') AS draws,
			       SUM(kills) AS kills, SUM(deaths) AS deaths,
			       SUM(EXTRACT(EPOCH FROM (last_seen - first_seen)) + ${poll}) / 60 AS minutes,
			       MAX(kills) AS best_kills, MAX(last_seen) AS last_seen, MIN(first_seen) AS first_seen
			  FROM player_match_stats
			 WHERE server_id IN ${ids} AND last_seen >= ${from}
			 GROUP BY steam_id
		), latest AS (
			SELECT DISTINCT ON (steam_id) steam_id, name, cash
			  FROM player_match_stats
			 WHERE server_id IN ${ids} AND last_seen >= ${from}
			 ORDER BY steam_id, last_seen DESC
		), ranked AS (
			SELECT a.*, l.name, l.cash,
			       CASE WHEN a.deaths > 0 THEN a.kills::float / a.deaths ELSE a.kills::float END AS kd,
			       CASE WHEN a.minutes > 0 THEN a.kills * 60.0 / a.minutes ELSE 0 END AS kph,
			       CASE WHEN a.wins + a.losses + a.draws >= ${MIN_DECIDED}
			            THEN a.wins::float / (a.wins + a.losses + a.draws) END AS win_rate,
			       COUNT(*) OVER () AS eligible
			  FROM agg a JOIN latest l USING (steam_id)
			 WHERE a.minutes >= ${minMinutes}
		)`;
}

function shapeRow(r: AggRow, rank: number): LeaderboardRow {
	return {
		rank,
		steamId: r.steamId,
		name: r.name,
		avatar: r.avatar || null,
		matches: num(r.matches),
		wins: num(r.wins),
		losses: num(r.losses),
		draws: num(r.draws),
		winRate: r.winRate === null ? null : round(num(r.winRate) * 100, 1),
		kills: num(r.kills),
		deaths: num(r.deaths),
		kd: round(num(r.kd), 2),
		kph: round(num(r.kph), 1),
		minutes: Math.round(num(r.minutes)),
		cash: num(r.cash),
		bestKills: num(r.bestKills),
		lastSeen: isoOf(r.lastSeen) ?? ''
	};
}

export async function loadLeaderboard(
	env: Env,
	servers: { id: string; name: string }[],
	opts: { scope: 'server' | 'org'; range: CareerRange; sort: LeaderboardSort; minMinutes: number }
): Promise<LeaderboardView> {
	const poll = pollSeconds(env) || 20;
	const from = rangeFrom(opts.range);
	const ids = servers.map((s) => s.id);
	const base = {
		scope: opts.scope,
		range: opts.range,
		sort: opts.sort,
		minMinutes: opts.minMinutes,
		servers,
		from: opts.range === 'all' ? null : from.toISOString(),
		pollSeconds: poll,
		minPresenceMinutes: MIN_PRESENCE_S / 60,
		minDecided: MIN_DECIDED
	};
	if (!ids.length) return { ...base, players: 0, eligible: 0, rows: [] };
	const [rows, [total]] = await Promise.all([
		env.db.execute<AggRow & { rank: string }>(sql`
			WITH ${boardCte(ids, from, poll, opts.minMinutes)}
			SELECT r.steam_id AS "steamId", r.name, sp.avatar, r.matches, r.wins, r.losses, r.draws,
			       r.kills, r.deaths, r.minutes, r.best_kills AS "bestKills", r.cash, r.kd, r.kph,
			       r.win_rate AS "winRate", r.last_seen AS "lastSeen", r.eligible,
			       RANK() OVER (ORDER BY ${sql.raw(SORTS[opts.sort])}) AS rank
			  FROM ranked r LEFT JOIN steam_profiles sp ON sp.steam_id = r.steam_id
			 ORDER BY rank, r.kills DESC, r.steam_id
			 LIMIT ${MAX_ROWS}`),
		env.db.execute<{ n: string }>(sql`
			SELECT COUNT(DISTINCT steam_id) AS n FROM player_match_stats
			 WHERE server_id IN ${ids} AND last_seen >= ${from}`)
	]);
	return {
		...base,
		players: num(total?.n),
		eligible: num(rows[0]?.eligible),
		rows: (rows as (AggRow & { rank: string })[]).map((r) => shapeRow(r, num(r.rank)))
	};
}

type Breakdown = {
	key: string;
	matches: string;
	wins: string;
	losses: string;
	draws: string;
	kills: string;
	deaths: string;
	minutes: string;
};
const shapeBreakdown = (r: Breakdown) => ({
	matches: num(r.matches),
	wins: num(r.wins),
	losses: num(r.losses),
	draws: num(r.draws),
	kills: num(r.kills),
	deaths: num(r.deaths),
	minutes: Math.round(num(r.minutes))
});

/** The current run of identical results, newest first: "5 wins in a row". */
export function streakOf(
	results: (MatchResult | null)[]
): { result: MatchResult; length: number } | null {
	const decided = results.filter((r): r is MatchResult => r !== null);
	if (!decided.length) return null;
	let length = 1;
	while (length < decided.length && decided[length] === decided[0]) length++;
	return { result: decided[0], length };
}

/** A player's career across these servers: totals, ranks on the board, per map and faction, recent matches. */
export async function careerFor(
	env: Env,
	servers: { id: string; name: string }[],
	steamId: string
): Promise<CareerView> {
	const poll = pollSeconds(env) || 20;
	const ids = servers.map((s) => s.id);
	const nameOf = new Map(servers.map((s) => [s.id, s.name]));
	const empty: CareerView = {
		since: null,
		matches: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		winRate: null,
		kills: 0,
		deaths: 0,
		kd: 0,
		kph: 0,
		minutes: 0,
		bestKills: 0,
		streak: null,
		ranks: {
			eligible: 0,
			minMinutes: DEFAULT_MIN_MINUTES,
			kills: null,
			kd: null,
			kph: null,
			minutes: null,
			winRate: null
		},
		maps: [],
		factions: [],
		recent: []
	};
	if (!ids.length) return empty;
	const from = new Date(0);
	const played = sql`EXTRACT(EPOCH FROM (s.last_seen - s.first_seen)) + ${poll} >= ${MIN_PRESENCE_S}`;
	const breakdown = (key: SQL) => sql`
		SELECT ${key} AS key,
		       COUNT(*) FILTER (WHERE ${played}) AS matches,
		       COUNT(*) FILTER (WHERE ${played} AND s.result = 'win') AS wins,
		       COUNT(*) FILTER (WHERE ${played} AND s.result = 'loss') AS losses,
		       COUNT(*) FILTER (WHERE ${played} AND s.result = 'draw') AS draws,
		       SUM(s.kills) AS kills, SUM(s.deaths) AS deaths,
		       SUM(EXTRACT(EPOCH FROM (s.last_seen - s.first_seen)) + ${poll}) / 60 AS minutes
		  FROM player_match_stats s LEFT JOIN matches m ON m.id = s.match_id
		 WHERE s.steam_id = ${steamId} AND s.server_id IN ${ids}
		 GROUP BY key ORDER BY minutes DESC`;
	const [[totals], [ranks], [eligibleRow], maps, factions, recent] = await Promise.all([
		env.db.execute<AggRow & { firstSeen: Date | null }>(sql`
			WITH ${boardCte(ids, from, poll, 0)}
			SELECT r.steam_id AS "steamId", r.name, NULL AS avatar, r.matches, r.wins, r.losses, r.draws,
			       r.kills, r.deaths, r.minutes, r.best_kills AS "bestKills", r.cash, r.kd, r.kph,
			       r.win_rate AS "winRate", r.last_seen AS "lastSeen", r.first_seen AS "firstSeen", r.eligible
			  FROM ranked r WHERE r.steam_id = ${steamId}`),
		env.db.execute<{
			eligible: string;
			kills: string;
			kd: string;
			kph: string;
			minutes: string;
			winRate: string | null;
		}>(sql`
			WITH ${boardCte(ids, from, poll, DEFAULT_MIN_MINUTES)}
			SELECT * FROM (
				SELECT r.steam_id, r.eligible,
				       RANK() OVER (ORDER BY r.kills DESC) AS kills,
				       RANK() OVER (ORDER BY r.kd DESC) AS kd,
				       RANK() OVER (ORDER BY r.kph DESC) AS kph,
				       RANK() OVER (ORDER BY r.minutes DESC) AS minutes,
				       CASE WHEN r.win_rate IS NULL THEN NULL
				            ELSE RANK() OVER (ORDER BY r.win_rate DESC NULLS LAST) END AS "winRate"
				  FROM ranked r) x
			 WHERE x.steam_id = ${steamId}`),
		// how many players clear the floor, whether or not this one does
		env.db.execute<{ n: string }>(sql`
			WITH ${boardCte(ids, from, poll, DEFAULT_MIN_MINUTES)}
			SELECT COUNT(*) AS n FROM ranked`),
		env.db.execute<Breakdown>(breakdown(sql`COALESCE(m.map, '')`)),
		env.db.execute<Breakdown>(breakdown(sql`COALESCE(s.faction, '')`)),
		env.db.execute<{
			matchId: string;
			serverId: string;
			map: string | null;
			experiences: string | null;
			startedAt: Date | null;
			endedAt: Date | null;
			faction: string | null;
			result: MatchResult | null;
			kills: number;
			deaths: number;
			cash: number;
			firstSeen: Date;
			lastSeen: Date;
			winner: string | null;
			finalScores: unknown;
		}>(sql`
			SELECT s.match_id AS "matchId", s.server_id AS "serverId", m.map, m.experiences,
			       m.started_at AS "startedAt", m.ended_at AS "endedAt", s.faction, s.result,
			       s.kills, s.deaths, s.cash, s.first_seen AS "firstSeen", s.last_seen AS "lastSeen",
			       m.winner, m.final_scores AS "finalScores"
			  FROM player_match_stats s LEFT JOIN matches m ON m.id = s.match_id
			 WHERE s.steam_id = ${steamId} AND s.server_id IN ${ids}
			 ORDER BY s.last_seen DESC LIMIT 40`)
	]);
	const eligibleCount = num(eligibleRow?.n);
	const recentRows: CareerMatch[] = recent.map((r) => ({
		matchId: num(r.matchId),
		serverId: r.serverId,
		serverName: nameOf.get(r.serverId) || r.serverId,
		map: r.map,
		experiences: r.experiences,
		startedAt: isoOf(r.startedAt),
		endedAt: isoOf(r.endedAt),
		live: r.endedAt === null,
		faction: r.faction,
		result: r.result,
		kills: r.kills,
		deaths: r.deaths,
		cash: r.cash,
		minutes: Math.round(
			(new Date(r.lastSeen).getTime() - new Date(r.firstSeen).getTime()) / 60000 + poll / 60
		),
		counted:
			(new Date(r.lastSeen).getTime() - new Date(r.firstSeen).getTime()) / 1000 + poll >=
			MIN_PRESENCE_S,
		winner: r.winner
	}));
	if (!totals)
		return { ...empty, recent: recentRows, ranks: { ...empty.ranks, eligible: eligibleCount } };
	const t = shapeRow(totals as AggRow, 0);
	return {
		since: isoOf(totals.firstSeen),
		matches: t.matches,
		wins: t.wins,
		losses: t.losses,
		draws: t.draws,
		winRate: t.winRate,
		kills: t.kills,
		deaths: t.deaths,
		kd: t.kd,
		kph: t.kph,
		minutes: t.minutes,
		bestKills: t.bestKills,
		streak: streakOf(recentRows.filter((r) => r.counted && !r.live).map((r) => r.result)),
		ranks: {
			eligible: eligibleCount,
			minMinutes: DEFAULT_MIN_MINUTES,
			kills: ranks ? numOrNull(ranks.kills) : null,
			kd: ranks ? numOrNull(ranks.kd) : null,
			kph: ranks ? numOrNull(ranks.kph) : null,
			minutes: ranks ? numOrNull(ranks.minutes) : null,
			winRate: ranks ? numOrNull(ranks.winRate) : null
		},
		maps: (maps as Breakdown[]).map((r) => ({ map: r.key, ...shapeBreakdown(r) })),
		factions: (factions as Breakdown[]).map((r) => ({ faction: r.key, ...shapeBreakdown(r) })),
		recent: recentRows
	};
}

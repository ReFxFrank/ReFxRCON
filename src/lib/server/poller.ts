// Background sampler: every POLL_SECONDS it asks each game server for status and players, stores
// a sample, and turns the player list into sessions and match boundaries. Only one process polls:
// the leader holds a Postgres advisory lock on a reserved connection, so extra replicas stay idle.
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Env } from './env';
import { pollSeconds } from './env';
import { publicMessage } from './http';
import type { OrgRow, ServerRow } from './access';
import { ACTIONS } from './actions';
import { WardogsClient } from './rcon';
import {
	matches,
	organizations,
	playerMatchStats,
	playerSessions,
	samples,
	servers
} from './db/schema';
import { getProfiles, steamEnabled } from './steam';
import { runTriggers } from './triggers';
import {
	baselineAfterGap,
	closingScores,
	counterDelta,
	matchBoundary,
	matchOutcome,
	type Score
} from './match-track';
import { markBoardsOffline, refreshBoards } from './status-board';
import { effectiveFeatures, publicLinks } from './features';
import {
	expireEntries,
	liveObserved,
	reconcileServer,
	writeSnapshot,
	type Observed
} from './lists-sync';
import type { Player, Status } from '$lib/types';
import { cashByFaction } from '$lib/cash';

export { pollSeconds };

/*
 * D8. Must match the TimescaleDB policy in drizzle/0016_sample_retention_120_days.sql -- on
 * plain Postgres this constant is the ONLY thing pruning samples, and on TimescaleDB the two
 * run independently, so a mismatch means one of them is dead code.
 *
 * 120 and not 90 because the analytics panels offer a 90-day window; at 90-day retention its far
 * end was always being pruned out from under it. Costs about 125 MB at four servers and a 20s
 * poll (measured: 240 bytes per row including indexes).
 */
const SAMPLE_RETENTION_DAYS = 120;
const SESSION_RETENTION_DAYS = 365;
/** Close open sessions after this many consecutive failed polls. */
const OFFLINE_AFTER_FAILURES = 3;
/** Any stable 64-bit constant; identifies "the Warcon poller" to pg_try_advisory_lock. */
const LEADER_LOCK_KEY = 7741221;
/** How often each server's ban list and reserved slots are re-read for the trigger engine. */
const LISTS_TTL_MS = 5 * 60_000;

/** What a public card says when the panel cannot reach a server; the real error names the RCON address. */
const OFFLINE_PROBLEM = 'The panel could not reach the game server.';

interface Memory {
	inFlight: boolean;
	/** a Discord board render is running for this server; the next one waits for the tick after */
	boardsInFlight: boolean;
	failures: number;
	lastMatchSeconds: number | null;
	/** Scores from the previous sample: the last known state of a match that just ended. */
	lastScores: unknown;
	/** No successful tick yet in this process: every open session would look like a join. */
	firstTick: boolean;
	/** Ban list and reserved slots, refreshed every LISTS_TTL_MS. */
	listsAt: number;
	reserved: Set<string>;
}

const memory = new Map<string, Memory>();
const mem = (id: string): Memory => {
	let m = memory.get(id);
	if (!m) {
		m = {
			inFlight: false,
			boardsInFlight: false,
			failures: 0,
			lastMatchSeconds: null,
			lastScores: null,
			firstTick: true,
			listsAt: 0,
			reserved: new Set()
		};
		memory.set(id, m);
	}
	return m;
};

/** Runs one board delivery per server at a time, detached from the tick that asked for it. */
function deliverBoards(m: Memory, run: () => Promise<void>): void {
	if (m.boardsInFlight) return;
	m.boardsInFlight = true;
	void run()
		.catch((err) => console.error('[warcon] status boards', err))
		.finally(() => {
			m.boardsInFlight = false;
		});
}

declare global {
	// Survives Vite HMR re-evaluation in dev so we never run two loops.
	var __warconPoller: ReturnType<typeof setInterval> | undefined;
}

type Reserved = Awaited<ReturnType<Env['sql']['reserve']>>;
let leaderConn: Reserved | null = null;
let leader = false;

/** Tries (once per tick) to become the poller for this database. The lock lives on a reserved connection. */
async function ensureLeader(env: Env): Promise<boolean> {
	if (leader) return true;
	try {
		leaderConn ??= await env.sql.reserve();
		const [row] = (await leaderConn`SELECT pg_try_advisory_lock(${LEADER_LOCK_KEY}) AS ok`) as {
			ok: boolean;
		}[];
		leader = !!row?.ok;
		if (leader) console.log('[warcon] this instance is the analytics poller');
		return leader;
	} catch (err) {
		console.error('[warcon] leader lock', err);
		leaderConn = null;
		return false;
	}
}

export function startPoller(env: Env): void {
	const seconds = pollSeconds(env);
	if (globalThis.__warconPoller) clearInterval(globalThis.__warconPoller);
	if (!seconds) {
		console.log('[warcon] analytics poller disabled (POLL_SECONDS=0)');
		return;
	}
	let ticks = 0;
	const tick = async () => {
		if (!(await ensureLeader(env))) return;
		await expireEntries(env).catch((err) => console.error('[warcon] list expiry', err));
		await pollAll(env).catch((err) => console.error('[warcon] poll', err));
		if (ticks++ % Math.max(1, Math.floor(3600 / seconds)) === 0)
			await prune(env).catch((err) => console.error('[warcon] prune', err));
	};
	globalThis.__warconPoller = setInterval(() => void tick(), seconds * 1000);
	setTimeout(() => void tick(), 2000);
	console.log(`[warcon] analytics poller every ${seconds}s`);
}

export async function pollAll(env: Env): Promise<void> {
	const all = await env.db
		.select({ server: servers, org: organizations })
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId));
	await Promise.all(all.map(({ server, org }) => pollServer(env, server, org)));
}

export async function pollServer(env: Env, server: ServerRow, org: OrgRow): Promise<void> {
	const m = mem(server.id);
	if (m.inFlight) return;
	m.inFlight = true;
	const started = Date.now();
	const ts = new Date();
	try {
		let status: Status;
		let players: Player[];
		let client: WardogsClient;
		try {
			client = await WardogsClient.forServer(env, server);
			status = (await ACTIONS.status.run(client, {})) as Status;
			players = ((await ACTIONS.players.run(client, {})) as { players: Player[] }).players;
		} catch (err) {
			m.failures++;
			const problem = publicMessage(err, 'Poll failed.').slice(0, 300);
			await env.db.insert(samples).values({
				serverId: server.id,
				ts,
				ok: false,
				latencyMs: Date.now() - started,
				error: problem
			});
			if (m.failures === OFFLINE_AFTER_FAILURES) {
				await env.db
					.update(playerSessions)
					.set({ leftAt: sql`${playerSessions.lastSeen}` })
					.where(and(eq(playerSessions.serverId, server.id), isNull(playerSessions.leftAt)));
				m.lastMatchSeconds = null;
				// Off the sampling path, and never the raw error: it names the RCON host and port,
				// and the card is public.
				deliverBoards(m, () => markBoardsOffline(env, server, OFFLINE_PROBLEM, ts));
			}
			return;
		}
		// Joins seen on the first tick of a process, or right after an outage closed every session,
		// are reconnects or people who were there all along: no whispers or kicks for those.
		const joinsReliable = !m.firstTick && m.failures === 0;
		m.failures = 0;
		m.firstTick = false;
		const scores = status.scores.map((s) => ({ name: s.name, score: s.score }));
		await env.db.insert(samples).values({
			serverId: server.id,
			ts,
			ok: true,
			playerCount: status.playerCount,
			maxPlayers: status.maxPlayers,
			map: status.map,
			experiences: status.experiences.join('+'),
			lighting: status.lighting,
			matchSeconds: status.matchSeconds,
			scores,
			cash: cashByFaction(status, players),
			latencyMs: Date.now() - started
		});
		// The match first: when this sample starts a new one, the players' counters have reset with
		// it, and their increments belong to the new match. Per-match player rows are written only
		// where match statistics are switched on (both the org's allowance and the server's switch).
		const features = effectiveFeatures(org, server);
		const match = await reconcileMatch(env, server.id, ts, status, m, scores);
		const { joined, firstVisit } = await reconcileSessions(env, server.id, ts, players, {
			match: match.id !== null ? { id: match.id, startedAt: match.startedAt! } : null,
			fresh: match.fresh,
			stats: features.stats
		});
		const observed = await refreshLists(env, server, client, m, ts).catch((err) => {
			console.warn('[warcon] ban list snapshot', publicMessage(err));
			return null;
		});
		// Push the org's ban and reserved lists. Plans against the snapshot (fresh or from an
		// earlier tick) and re-reads the server before changing anything; never throws.
		const synced = await reconcileServer(env, server, org, {
			reason: 'poll',
			waitMs: 0,
			client,
			observed: observed ?? undefined
		}).catch((err) => {
			console.warn('[warcon] list sync', publicMessage(err));
			return null;
		});
		if (synced?.observed) m.reserved = new Set(synced.observed.reserved);
		// Discord status boards whose interval has elapsed. Delivery can wait on Discord for
		// seconds per board, so it runs off the sampling path: the next tick must not be skipped
		// because a webhook is slow.
		deliverBoards(m, () =>
			refreshBoards(env, server, {
				status,
				players,
				ts,
				stats: features.stats,
				links: publicLinks(env.ORIGIN, org, server)
			})
		);
		// Warm the Steam cache for newcomers so the players table and dossier have their data.
		if (joined.length && steamEnabled(env))
			await getProfiles(
				env,
				joined.map((p) => p.steamId)
			);
		await runTriggers(env, {
			server,
			client,
			status,
			players,
			joined,
			firstVisit,
			reserved: m.reserved,
			joinsReliable,
			ts
		});
	} finally {
		m.inFlight = false;
	}
}

/**
 * Re-reads the ban list and reserved slots now and then, keeping copies in server_bans and
 * server_reserved for the dossier and the list sync. Returns what it read, or null when the
 * copies are still fresh.
 */
async function refreshLists(
	env: Env,
	server: ServerRow,
	client: WardogsClient,
	m: Memory,
	ts: Date
): Promise<Observed | null> {
	if (ts.getTime() - m.listsAt < LISTS_TTL_MS) return null;
	m.listsAt = ts.getTime();
	const observed = await liveObserved(client);
	m.reserved = new Set(observed.reserved);
	await writeSnapshot(env, server.id, observed, ts);
	return observed;
}

/**
 * Turns this sample's player list into sessions and per-match rows, and returns who joined this
 * tick (no open session before it) and which of those were never seen on this server. Kills and
 * deaths are stored as increments over the previous reading (see match-track.ts): the session
 * accumulates them for as long as the player stays, the match row for as long as the match runs.
 */
async function reconcileSessions(
	env: Env,
	serverId: string,
	ts: Date,
	players: Player[],
	opts: {
		/** the match this sample belongs to */
		match: { id: number; startedAt: Date } | null;
		/** this sample began the match: every counter has reset, so the reading is the increment */
		fresh: boolean;
		/** write per-match rows (match statistics are on for this server) */
		stats: boolean;
	}
): Promise<{ joined: Player[]; firstVisit: Set<string> }> {
	const open = await env.db
		.select({
			id: playerSessions.id,
			steamId: playerSessions.steamId,
			kills: playerSessions.kills,
			deaths: playerSessions.deaths,
			rawKills: playerSessions.rawKills,
			rawDeaths: playerSessions.rawDeaths
		})
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));
	const byId = new Map(open.map((s) => [s.steamId, s]));
	// Players with no open session may have had one that an outage closed while this match kept
	// running; their last raw reading is then the baseline, or their counters would count twice.
	const newcomers = players.map((p) => p.steamId).filter((id) => id && !byId.has(id));
	const lastClosed = new Map<
		string,
		{ leftAt: Date; rawKills: number | null; rawDeaths: number | null }
	>();
	if (newcomers.length && opts.match && !opts.fresh) {
		const rows = await env.db.execute<{
			steamId: string;
			leftAt: Date;
			rawKills: number | null;
			rawDeaths: number | null;
		}>(sql`
			SELECT DISTINCT ON (steam_id) steam_id AS "steamId", left_at AS "leftAt",
			       COALESCE(raw_kills, kills) AS "rawKills", COALESCE(raw_deaths, deaths) AS "rawDeaths"
			  FROM player_sessions
			 WHERE server_id = ${serverId} AND steam_id IN ${newcomers} AND left_at IS NOT NULL
			   AND left_at >= ${opts.match.startedAt}
			 ORDER BY steam_id, left_at DESC`);
		for (const r of rows)
			lastClosed.set(r.steamId, {
				leftAt: new Date(r.leftAt),
				rawKills: r.rawKills,
				rawDeaths: r.rawDeaths
			});
	}
	const seen = new Set<string>();
	const joined: Player[] = [];
	const firstVisit = new Set<string>();
	await env.db.transaction(async (tx) => {
		const joins: (typeof playerSessions.$inferInsert)[] = [];
		const inMatch: (typeof playerMatchStats.$inferInsert)[] = [];
		for (const p of players) {
			if (!p.steamId || seen.has(p.steamId)) continue;
			seen.add(p.steamId);
			const row = byId.get(p.steamId);
			const gap = lastClosed.get(p.steamId);
			// Rows from before increments were tracked hold the last raw reading in kills/deaths.
			// On the sample that began the match the counters have just reset for everyone.
			const baseK = opts.fresh
				? null
				: row
					? (row.rawKills ?? row.kills)
					: baselineAfterGap(gap?.leftAt, gap?.rawKills, opts.match?.startedAt);
			const baseD = opts.fresh
				? null
				: row
					? (row.rawDeaths ?? row.deaths)
					: baselineAfterGap(gap?.leftAt, gap?.rawDeaths, opts.match?.startedAt);
			const dk = counterDelta(p.kills, baseK);
			const dd = counterDelta(p.deaths, baseD);
			if (row) {
				await tx
					.update(playerSessions)
					.set({
						name: p.name,
						faction: p.faction,
						lastSeen: ts,
						kills: row.kills + dk,
						deaths: row.deaths + dd,
						cash: p.cash,
						rawKills: p.kills,
						rawDeaths: p.deaths
					})
					.where(eq(playerSessions.id, row.id));
			} else {
				joined.push(p);
				joins.push({
					serverId,
					steamId: p.steamId,
					name: p.name,
					faction: p.faction,
					joinedAt: ts,
					lastSeen: ts,
					kills: dk,
					deaths: dd,
					cash: p.cash,
					rawKills: p.kills,
					rawDeaths: p.deaths
				});
			}
			if (opts.stats && opts.match)
				inMatch.push({
					matchId: opts.match.id,
					serverId,
					steamId: p.steamId,
					name: p.name,
					faction: p.faction,
					firstSeen: ts,
					lastSeen: ts,
					kills: dk,
					deaths: dd,
					cash: p.cash
				});
		}
		if (inMatch.length)
			await tx
				.insert(playerMatchStats)
				.values(inMatch)
				.onConflictDoUpdate({
					target: [playerMatchStats.matchId, playerMatchStats.steamId],
					set: {
						name: sql`excluded.name`,
						faction: sql`excluded.faction`,
						lastSeen: ts,
						kills: sql`${playerMatchStats.kills} + excluded.kills`,
						deaths: sql`${playerMatchStats.deaths} + excluded.deaths`,
						cash: sql`excluded.cash`
					}
				});
		if (joins.length) {
			const known = await tx
				.selectDistinct({ steamId: playerSessions.steamId })
				.from(playerSessions)
				.where(
					and(
						eq(playerSessions.serverId, serverId),
						inArray(
							playerSessions.steamId,
							joins.map((j) => j.steamId)
						)
					)
				);
			const knownIds = new Set(known.map((k) => k.steamId));
			for (const j of joins) if (!knownIds.has(j.steamId)) firstVisit.add(j.steamId);
			await tx.insert(playerSessions).values(joins);
		}
		const gone = open.filter((s) => !seen.has(s.steamId)).map((s) => s.id);
		for (const id of gone)
			await tx
				.update(playerSessions)
				.set({ leftAt: sql`${playerSessions.lastSeen}` })
				.where(eq(playerSessions.id, id));
	});
	return { joined, firstVisit };
}

/**
 * Opens and closes matches; returns the match this sample belongs to and whether this sample
 * began it (then every player's counters have just reset).
 */
async function reconcileMatch(
	env: Env,
	serverId: string,
	ts: Date,
	status: Status,
	m: Memory,
	scores: Score[]
): Promise<{ id: number | null; startedAt: Date | null; fresh: boolean }> {
	const [current] = await env.db
		.select({
			id: matches.id,
			map: matches.map,
			startedAt: matches.startedAt,
			peakPlayers: matches.peakPlayers
		})
		.from(matches)
		.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
		.orderBy(desc(matches.id))
		.limit(1);
	const secs = status.matchSeconds ?? null;
	const boundary = matchBoundary({
		matchSeconds: secs,
		lastMatchSeconds: m.lastMatchSeconds,
		current: current ?? null,
		map: status.map,
		ts
	});
	m.lastMatchSeconds = secs;
	if (current && boundary) await closeMatch(env, current.id, ts, m, boundary);
	let id = current?.id ?? null;
	let startedAt = current?.startedAt ?? null;
	if (!current || boundary) {
		startedAt = secs !== null ? new Date(ts.getTime() - secs * 1000) : ts;
		const [row] = await env.db
			.insert(matches)
			.values({
				serverId,
				startedAt,
				map: status.map,
				experiences: status.experiences.join('+'),
				lighting: status.lighting,
				peakPlayers: status.playerCount
			})
			.returning({ id: matches.id });
		id = row?.id ?? null;
	} else if (status.playerCount > current.peakPlayers) {
		await env.db
			.update(matches)
			.set({ peakPlayers: status.playerCount })
			.where(eq(matches.id, current.id));
	}
	m.lastScores = scores;
	return { id, startedAt, fresh: boundary !== null };
}

/**
 * Ends a match with the last scores seen while it ran and hands every player in it their result.
 * After an outage (`stale`) the previous scores belong to some other match, and on a fresh
 * process there are none: the match closes with no outcome rather than a wrong one.
 */
async function closeMatch(
	env: Env,
	matchId: number,
	ts: Date,
	m: Memory,
	boundary: 'restarted' | 'map' | 'stale'
): Promise<void> {
	const last = closingScores(boundary, m.lastScores as Score[] | null);
	const outcome = matchOutcome(last);
	await env.db.transaction(async (tx) => {
		await tx
			.update(matches)
			.set({ endedAt: ts, finalScores: last, winner: outcome.winner })
			.where(eq(matches.id, matchId));
		if (!outcome.scored) return;
		await tx
			.update(playerMatchStats)
			.set({
				result: outcome.draw
					? sql`CASE WHEN ${playerMatchStats.faction} IS NULL OR ${playerMatchStats.faction} = '' THEN NULL ELSE 'draw' END`
					: sql`CASE WHEN ${playerMatchStats.faction} IS NULL OR ${playerMatchStats.faction} = '' THEN NULL WHEN ${playerMatchStats.faction} = ${outcome.winner} THEN 'win' ELSE 'loss' END`
			})
			.where(eq(playerMatchStats.matchId, matchId));
	});
}

async function prune(env: Env): Promise<void> {
	const cutSessions = new Date(Date.now() - SESSION_RETENTION_DAYS * 86400000);
	// TimescaleDB's retention policy drops old sample chunks; plain Postgres needs this delete.
	if (!env.timescale)
		await env.db
			.delete(samples)
			.where(lt(samples.ts, new Date(Date.now() - SAMPLE_RETENTION_DAYS * 86400000)));
	await env.db
		.delete(playerSessions)
		.where(and(lt(playerSessions.leftAt, cutSessions), gt(playerSessions.id, 0)));
	await env.db.delete(playerMatchStats).where(lt(playerMatchStats.lastSeen, cutSessions));
	await env.db.delete(matches).where(lt(matches.endedAt, cutSessions));
}

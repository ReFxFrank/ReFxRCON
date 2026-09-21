// The public face of a server: pages and JSON anyone can open without an account, when the
// site owner allows it for the organisation and an org owner switched it on for the server.
// Everything here is built from what the poller already stored (the last sample, the open
// match's rows, sessions), never from a live RCON call, so a crowd of viewers costs the game
// server nothing; the status view is also cached briefly per server.
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Env } from './env';
import { pollSeconds } from './env';
import { ApiError, clientIp } from './http';
import { assertRate } from './ratelimit';
import { effectiveFeatures, type FeatureKey, type Features } from './features';
import {
	organizations,
	playerSessions,
	samples,
	servers,
	type OrgRow,
	type ServerRow
} from './db/schema';
import { currentMatchData } from './status-board';
import { careerFor, loadLeaderboard } from './career';
import type {
	CareerRange,
	CareerView,
	LeaderboardSort,
	LeaderboardView,
	PublicStatusView
} from '$lib/types';

export interface PublicTarget {
	server: ServerRow;
	org: OrgRow;
	features: Features;
}

/** The server with its org and effective features; null when there is no such server. */
export async function publicTarget(env: Env, serverId: string): Promise<PublicTarget | null> {
	if (!serverId || serverId.length > 64) return null;
	const [row] = await env.db
		.select({ server: servers, org: organizations })
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.where(eq(servers.id, serverId))
		.limit(1);
	if (!row || row.org.suspendedAt) return null;
	return { server: row.server, org: row.org, features: effectiveFeatures(row.org, row.server) };
}

/** 404 (never 403: a closed page should look like no page) unless the feature is on. */
export function requirePublic(t: PublicTarget | null, key: FeatureKey): PublicTarget {
	if (!t || !t.features[key]) throw new ApiError(404, 'Not found.', 'not_found');
	return t;
}

/** Public JSON is unauthenticated: a modest per-address budget keeps a scraper from hurting the database. */
export const publicRate = (req: Request): void =>
	assertRate(`public:${clientIp(req) || 'unknown'}`, 120, 60_000);

// ---- status -------------------------------------------------------------------------------------

const STATUS_TTL_MS = 5_000;
const statusCache = new Map<string, { until: number; view: PublicStatusView }>();

export async function publicStatus(env: Env, t: PublicTarget): Promise<PublicStatusView> {
	const hit = statusCache.get(t.server.id);
	if (hit && hit.until > Date.now()) return hit.view;
	const view = await buildStatus(env, t);
	statusCache.set(t.server.id, { until: Date.now() + STATUS_TTL_MS, view });
	return view;
}

async function buildStatus(env: Env, t: PublicTarget): Promise<PublicStatusView> {
	const now = new Date();
	const id = t.server.id;
	const [[latest], [lastOk], data, open] = await Promise.all([
		env.db
			.select({ ts: samples.ts, ok: samples.ok, error: samples.error })
			.from(samples)
			.where(eq(samples.serverId, id))
			.orderBy(desc(samples.ts))
			.limit(1),
		env.db
			.select()
			.from(samples)
			.where(and(eq(samples.serverId, id), eq(samples.ok, true)))
			.orderBy(desc(samples.ts))
			.limit(1),
		currentMatchData(env, id, now),
		env.db
			.select({
				steamId: playerSessions.steamId,
				name: playerSessions.name,
				faction: playerSessions.faction,
				kills: playerSessions.kills,
				deaths: playerSessions.deaths
			})
			.from(playerSessions)
			.where(and(eq(playerSessions.serverId, id), isNull(playerSessions.leftAt)))
	]);
	const online = new Set(open.map((s) => s.steamId));
	// With match statistics on, the open match's rows (kills since the match began, reconnects
	// included); otherwise the open sessions' running totals.
	const players = (
		t.features.stats
			? data.matchPlayers.map((p) => ({ ...p, online: online.has(p.steamId) }))
			: open.map((p) => ({ ...p, online: true }))
	)
		.filter((p) => p.online || p.kills > 0 || p.deaths > 0)
		.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name))
		.slice(0, 100)
		.map((p) => ({
			steamId: p.steamId,
			name: p.name,
			faction: p.faction,
			kills: p.kills,
			deaths: p.deaths,
			online: p.online
		}));
	const scores = Array.isArray(lastOk?.scores)
		? (lastOk!.scores as { name: string; score: number }[])
		: [];
	const cash = Array.isArray(lastOk?.cash)
		? (lastOk!.cash as { name: string; cash: number }[])
		: [];
	return {
		server: { id, name: t.server.name },
		org: { name: t.org.name, slug: t.org.slug },
		features: { publicStats: t.features.publicStats, stats: t.features.stats },
		pollSeconds: pollSeconds(env) || 20,
		generatedAt: now.toISOString(),
		sampledAt: lastOk?.ts ? lastOk.ts.toISOString() : null,
		reachable: !!latest?.ok,
		// Never the stored error: it names the RCON host and port, and this view is public.
		error: latest?.ok
			? ''
			: latest
				? 'The panel could not reach the game server.'
				: 'Not sampled yet.',
		map: lastOk?.map ?? null,
		experiences: lastOk?.experiences ? lastOk.experiences.split('+').filter(Boolean) : [],
		lighting: lastOk?.lighting ?? null,
		matchSeconds: lastOk?.matchSeconds ?? null,
		playerCount: lastOk?.playerCount ?? 0,
		maxPlayers: lastOk?.maxPlayers ?? 0,
		scores,
		cash,
		match: data.match
			? { startedAt: data.match.startedAt.toISOString(), peakPlayers: data.match.peakPlayers }
			: null,
		players,
		day: data.day
	};
}

/** Test-only. */
export const resetPublicCache = (): void => statusCache.clear();

// ---- leaderboards and careers -------------------------------------------------------------------

/** Every server of the org whose public stats are on (both levels), for an org-wide board. */
export async function publicStatsServers(
	env: Env,
	t: PublicTarget
): Promise<{ id: string; name: string }[]> {
	const rows = await env.db
		.select()
		.from(servers)
		.where(eq(servers.orgId, t.org.id))
		.orderBy(servers.sortOrder, servers.name);
	return rows
		.filter((s) => effectiveFeatures(t.org, s).publicStats)
		.map((s) => ({ id: s.id, name: s.name }));
}

export async function publicLeaderboard(
	env: Env,
	t: PublicTarget,
	opts: { scope: 'server' | 'org'; range: CareerRange; sort: LeaderboardSort; minMinutes: number }
): Promise<LeaderboardView> {
	const list =
		opts.scope === 'org'
			? await publicStatsServers(env, t)
			: [{ id: t.server.id, name: t.server.name }];
	return loadLeaderboard(env, list, opts);
}

/** A player's career over the org's public servers, plus the name they last used there. */
export async function publicCareer(
	env: Env,
	t: PublicTarget,
	steamId: string
): Promise<{ name: string; career: CareerView; servers: { id: string; name: string }[] }> {
	const list = await publicStatsServers(env, t);
	const career = await careerFor(env, list, steamId);
	const name = career.recent[0]?.matchId
		? ((await latestName(
				env,
				list.map((s) => s.id),
				steamId
			)) ?? steamId)
		: steamId;
	return { name, career, servers: list };
}

async function latestName(env: Env, ids: string[], steamId: string): Promise<string | null> {
	if (!ids.length) return null;
	const { sql } = await import('drizzle-orm');
	const [row] = await env.db.execute<{ name: string }>(sql`
		SELECT name FROM player_match_stats WHERE steam_id = ${steamId} AND server_id IN ${ids}
		 ORDER BY last_seen DESC LIMIT 1`);
	return row?.name ?? null;
}

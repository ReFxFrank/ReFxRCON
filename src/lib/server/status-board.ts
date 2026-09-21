// Live status boards: one Discord message per server that the poller keeps editing, with the
// server's state in one embed and the current match's top players in another. A board borrows
// the URL of one of the org's webhooks (so the credential stays in one place) and remembers the
// message it posted, so the channel shows a single always-current card rather than a feed.
// The embeds themselves are built in status-board-embeds.ts (pure); this module owns the records
// and talks to Discord through webhook-delivery.ts.
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { pollSeconds } from './env';
import { ApiError, int, newId, publicMessage } from './http';
import { writeAudit } from './audit';
import type { OrgRow, ServerRow, SessionUser } from './access';
import { ACTIONS } from './actions';
import { WardogsClient } from './rcon';
import {
	matches,
	playerMatchStats,
	playerSessions,
	samples,
	servers,
	statusBoards,
	type StatusBoardRow
} from './db/schema';
import { encryptSecret } from './crypto';
import { validateWebhookUrl } from './webhooks';
import { effectiveFeatures, publicLinks, type PublicLinks } from './features';
import { deleteDiscord, editDiscord, postDiscord, type PostResult } from './webhook-delivery';
import { buildBoardEmbeds, type BoardInput } from './status-board-embeds';
import type { Player, StatusBoardView, Status } from '$lib/types';

export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 3600;
export const MAX_TOP_PLAYERS = 25;

// ---- records ------------------------------------------------------------------------------------

const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

function shape(b: StatusBoardRow, serverName: string): StatusBoardView {
	return {
		id: b.id,
		serverId: b.serverId,
		serverName,
		urlHint: b.urlHint,
		enabled: b.enabled,
		intervalSeconds: b.intervalSeconds,
		topPlayers: b.topPlayers,
		posted: !!b.messageId,
		lastUpdatedAt: iso(b.lastUpdatedAt),
		lastStatus: b.lastStatus,
		lastError: b.lastError,
		createdAt: iso(b.createdAt)
	};
}

export async function listBoards(env: Env, orgId: string): Promise<StatusBoardView[]> {
	const rows = await env.db
		.select({ board: statusBoards, serverName: servers.name })
		.from(statusBoards)
		.innerJoin(servers, eq(servers.id, statusBoards.serverId))
		.where(eq(statusBoards.orgId, orgId))
		.orderBy(asc(servers.sortOrder), asc(servers.name), asc(statusBoards.createdAt));
	return rows.map((r) => shape(r.board, r.serverName));
}

async function boardOf(env: Env, orgId: string, id: string): Promise<StatusBoardRow> {
	const [row] = await env.db
		.select()
		.from(statusBoards)
		.where(and(eq(statusBoards.id, id), eq(statusBoards.orgId, orgId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Status board not found.');
	return row;
}

async function serverOf(env: Env, orgId: string, id: string): Promise<ServerRow> {
	const [row] = await env.db
		.select()
		.from(servers)
		.where(and(eq(servers.id, id), eq(servers.orgId, orgId)))
		.limit(1);
	if (!row) throw new ApiError(400, 'Pick one of the organisation’s servers.');
	return row;
}

function parseInterval(env: Env, v: unknown, fallback: number): number {
	const floor = Math.max(MIN_INTERVAL_S, pollSeconds(env) || MIN_INTERVAL_S);
	return int(v, fallback, floor, MAX_INTERVAL_S);
}

async function viewOf(env: Env, row: StatusBoardRow): Promise<StatusBoardView> {
	const [v] = (await listBoards(env, row.orgId)).filter((b) => b.id === row.id);
	return v;
}

export async function createBoard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<StatusBoardView> {
	const server = await serverOf(env, org.id, String(body.serverId ?? ''));
	const { url, hint } = validateWebhookUrl(body.url);
	const [row] = await env.db
		.insert(statusBoards)
		.values({
			id: newId(),
			orgId: org.id,
			serverId: server.id,
			urlEnc: encryptSecret(env, url),
			urlHint: hint,
			enabled: body.enabled === undefined ? true : !!body.enabled,
			intervalSeconds: parseInterval(env, body.intervalSeconds, 60),
			topPlayers: int(body.topPlayers, 10, 1, MAX_TOP_PLAYERS),
			createdBy: user.id
		})
		.returning();
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		server: { id: server.id, name: server.name },
		category: 'org',
		action: 'org.board.create',
		target: server.name,
		outcome: 'ok',
		detail: {
			boardId: row.id,
			hint,
			intervalSeconds: row.intervalSeconds,
			topPlayers: row.topPlayers
		}
	});
	return viewOf(env, row);
}

export async function updateBoard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string,
	body: Record<string, unknown>
): Promise<StatusBoardView> {
	const row = await boardOf(env, org.id, id);
	const set: Partial<typeof statusBoards.$inferInsert> = {};
	const changes: Record<string, unknown> = {};
	if (typeof body.url === 'string' && body.url.trim()) {
		const { url, hint } = validateWebhookUrl(body.url);
		if (hint !== row.urlHint) {
			// A different webhook: the old card cannot be edited through the new one.
			await forgetMessage(env, row);
			set.messageId = null;
		}
		set.urlEnc = encryptSecret(env, url);
		set.urlHint = hint;
		set.lastError = '';
		set.lastStatus = null;
		changes.hint = hint;
	}
	if (body.intervalSeconds !== undefined)
		changes.intervalSeconds = set.intervalSeconds = parseInterval(
			env,
			body.intervalSeconds,
			row.intervalSeconds
		);
	if (body.topPlayers !== undefined)
		changes.topPlayers = set.topPlayers = int(body.topPlayers, row.topPlayers, 1, MAX_TOP_PLAYERS);
	if (body.enabled !== undefined) changes.enabled = set.enabled = !!body.enabled;
	if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	// Any change should show on the card straight away.
	set.lastUpdatedAt = null;
	const [updated] = await env.db
		.update(statusBoards)
		.set(set)
		.where(eq(statusBoards.id, row.id))
		.returning();
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.board.update',
		target: row.serverId,
		outcome: 'ok',
		detail: { boardId: row.id, ...changes }
	});
	return viewOf(env, updated);
}

/** Best effort: take the card out of the channel when a board goes away or moves. */
async function forgetMessage(env: Env, row: StatusBoardRow): Promise<void> {
	if (!row.messageId) return;
	await deleteDiscord(env, row, row.messageId);
}

export async function deleteBoard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<void> {
	const row = await boardOf(env, org.id, id);
	await forgetMessage(env, row);
	await env.db.delete(statusBoards).where(eq(statusBoards.id, row.id));
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.board.delete',
		target: row.serverId,
		outcome: 'ok',
		detail: { boardId: row.id }
	});
}

/** Posts or edits the card right now, reading the server first; also how a new board is tried out. */
export async function refreshBoardNow(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<PostResult> {
	const row = await boardOf(env, org.id, id);
	const server = await serverOf(env, org.id, row.serverId);
	let status: Status | null = null;
	let players: Player[] = [];
	let problem = '';
	try {
		const client = await WardogsClient.forServer(env, server);
		status = (await ACTIONS.status.run(client, {})) as Status;
		players = ((await ACTIONS.players.run(client, {})) as { players: Player[] }).players;
	} catch (err) {
		problem = publicMessage(err, 'Poll failed.');
	}
	const [result] = await renderBoards(
		env,
		server,
		[row],
		{
			status,
			players,
			problem,
			ts: new Date(),
			stats: effectiveFeatures(org, server).stats,
			links: publicLinks(env.ORIGIN, org, server)
		},
		true
	);
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		server: { id: server.id, name: server.name },
		category: 'org',
		action: 'org.board.refresh',
		target: server.name,
		outcome: result.ok ? 'ok' : 'error',
		status: result.status || undefined,
		message: result.ok ? 'Status board updated.' : result.error,
		detail: { boardId: row.id }
	});
	return result;
}

// ---- the poller's side --------------------------------------------------------------------------

export interface PollContext {
	status: Status | null;
	players: Player[];
	problem?: string;
	ts: Date;
	/** match statistics are on for this server; when off, the board shows live counters instead */
	stats?: boolean;
	/** where the card links out (public pages that are on, the org's Discord) */
	links?: PublicLinks;
}

/** Boards of this server whose interval has elapsed (or that never posted). */
async function dueBoards(
	env: Env,
	serverId: string,
	ts: Date,
	force: boolean
): Promise<StatusBoardRow[]> {
	const rows = await env.db
		.select()
		.from(statusBoards)
		.where(and(eq(statusBoards.serverId, serverId), eq(statusBoards.enabled, true)));
	if (force) return rows;
	return rows.filter(
		(b) => !b.lastUpdatedAt || b.lastUpdatedAt.getTime() + b.intervalSeconds * 1000 <= ts.getTime()
	);
}

/** Called after every successful poll of a server. Never throws. */
export async function refreshBoards(env: Env, server: ServerRow, ctx: PollContext): Promise<void> {
	try {
		const due = await dueBoards(env, server.id, ctx.ts, false);
		if (due.length) await renderBoards(env, server, due, ctx, false);
	} catch (err) {
		console.error('[warcon] status boards', err);
	}
}

/** Called once when a server is declared offline: every posted card says so. Never throws. */
export async function markBoardsOffline(
	env: Env,
	server: ServerRow,
	problem: string,
	ts: Date
): Promise<void> {
	try {
		const rows = (await dueBoards(env, server.id, ts, true)).filter((b) => b.messageId);
		if (rows.length)
			await renderBoards(env, server, rows, { status: null, players: [], problem, ts }, true);
	} catch (err) {
		console.error('[warcon] status boards offline', err);
	}
}

/** The open match, everyone seen in it, and the last 24 hours; also feeds the public status page. */
export async function currentMatchData(
	env: Env,
	serverId: string,
	ts: Date
): Promise<Pick<BoardInput, 'match' | 'matchPlayers' | 'day'>> {
	const [current] = await env.db
		.select({ id: matches.id, startedAt: matches.startedAt, peakPlayers: matches.peakPlayers })
		.from(matches)
		.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
		.orderBy(desc(matches.id))
		.limit(1);
	const dayAgo = new Date(ts.getTime() - 86400000);
	const [matchPlayers, [peak], [unique], [ended]] = await Promise.all([
		current
			? env.db
					.select({
						steamId: playerMatchStats.steamId,
						name: playerMatchStats.name,
						faction: playerMatchStats.faction,
						kills: playerMatchStats.kills,
						deaths: playerMatchStats.deaths
					})
					.from(playerMatchStats)
					.where(eq(playerMatchStats.matchId, current.id))
					.orderBy(desc(playerMatchStats.kills), asc(playerMatchStats.deaths))
					.limit(200)
			: Promise.resolve([]),
		env.db
			.select({ n: sql<number>`COALESCE(MAX(${samples.playerCount}), 0)` })
			.from(samples)
			.where(and(eq(samples.serverId, serverId), gte(samples.ts, dayAgo), eq(samples.ok, true))),
		env.db
			.select({ n: sql<number>`COUNT(DISTINCT ${playerSessions.steamId})` })
			.from(playerSessions)
			.where(and(eq(playerSessions.serverId, serverId), gte(playerSessions.lastSeen, dayAgo))),
		env.db
			.select({ n: sql<number>`COUNT(*)` })
			.from(matches)
			.where(
				and(
					eq(matches.serverId, serverId),
					or(gte(matches.endedAt, dayAgo), and(isNull(matches.endedAt), lte(matches.startedAt, ts)))
				)
			)
	]);
	return {
		match: current ? { startedAt: current.startedAt, peakPlayers: current.peakPlayers } : null,
		matchPlayers,
		day: {
			peak: Number(peak?.n ?? 0),
			unique: Number(unique?.n ?? 0),
			matches: Number(ended?.n ?? 0)
		}
	};
}

/** Renders and delivers each board; one result per board, in order. Records outcomes on the rows. */
async function renderBoards(
	env: Env,
	server: ServerRow,
	boards: StatusBoardRow[],
	ctx: PollContext,
	offlineOnly: boolean
): Promise<PostResult[]> {
	const data =
		ctx.status || !offlineOnly
			? await currentMatchData(env, server.id, ctx.ts)
			: { match: null, matchPlayers: [], day: null };
	// Without match statistics there are no per-match rows: rank the live counters instead
	// (what each connected player has done since they joined this match).
	if (ctx.stats === false)
		data.matchPlayers = ctx.players.map((p) => ({
			steamId: p.steamId,
			name: p.name,
			faction: p.faction,
			kills: p.kills,
			deaths: p.deaths
		}));
	const results: PostResult[] = [];
	for (const board of boards) {
		const embeds = buildBoardEmbeds({
			appName: env.APP_NAME || 'Warcon',
			serverName: server.name,
			status: ctx.status,
			problem: ctx.problem,
			players: ctx.players,
			match: data.match,
			matchPlayers: data.matchPlayers,
			day: data.day,
			topPlayers: board.topPlayers,
			intervalSeconds: board.intervalSeconds,
			now: ctx.ts,
			links: ctx.links
		});
		results.push(
			await locked(board.id, async () => {
				// The poller and a "Refresh" click can both arrive for a board that has no card yet;
				// under the lock, re-read which message (if any) exists so only one gets posted.
				const [fresh] = await env.db
					.select({ messageId: statusBoards.messageId })
					.from(statusBoards)
					.where(eq(statusBoards.id, board.id))
					.limit(1);
				if (!fresh) return { ok: false, status: 0, error: 'The board was removed.' };
				let result = fresh.messageId
					? await editDiscord(env, board, fresh.messageId, { embeds })
					: null;
				let messageId = fresh.messageId;
				if (!result || result.status === 404) {
					// No card yet, or Discord lost it (deleted by hand, channel purged): post a fresh one.
					result = await postDiscord(env, board, { embeds });
					messageId = result.ok ? (result.messageId ?? null) : null;
				}
				return record(env, board, result, ctx.ts, messageId);
			})
		);
	}
	return results;
}

/** One render at a time per board, so concurrent callers edit the same card instead of each posting one. */
const chains = new Map<string, Promise<unknown>>();
function locked<T>(boardId: string, fn: () => Promise<T>): Promise<T> {
	const prev = chains.get(boardId) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	chains.set(
		boardId,
		next.catch(() => {})
	);
	void next.finally(() => {
		if (chains.get(boardId) === next) chains.delete(boardId);
	});
	return next;
}

async function record(
	env: Env,
	board: StatusBoardRow,
	result: PostResult,
	ts: Date,
	messageId: string | null = board.messageId
): Promise<PostResult> {
	try {
		await env.db
			.update(statusBoards)
			.set({
				messageId,
				// a failed attempt still counts as an attempt, so a dead webhook is not hammered every poll
				lastUpdatedAt: ts,
				lastStatus: result.status,
				lastError: result.ok ? '' : result.error.slice(0, 300)
			})
			.where(eq(statusBoards.id, board.id));
	} catch (err) {
		console.error('[warcon] status board record', err);
	}
	return result;
}

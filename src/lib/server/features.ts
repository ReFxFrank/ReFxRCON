// Per-server features that cost something (storage for per-match stats, public pages anyone can
// hit) and are therefore switched at two levels: the site owner allows each one per organisation
// (a plan, a trial, a misbehaving tenant), and an org owner turns it on per server. A feature is
// on only when both agree. Pure; the rows come from access.ts and the poller.

export type FeatureKey = 'stats' | 'publicStatus' | 'publicStats';

/** The site owner's allowances on an organisation. */
export interface OrgAllowances {
	allowStats: boolean;
	allowPublicStatus: boolean;
	allowPublicStats: boolean;
}

/** An org owner's switches on a server. */
export interface ServerSwitches {
	statsEnabled: boolean;
	publicStatus: boolean;
	publicStats: boolean;
}

/** What is actually on for a server. */
export type Features = Record<FeatureKey, boolean>;

export const FEATURE_LABELS: Record<FeatureKey, { name: string; blurb: string }> = {
	stats: {
		name: 'Match statistics',
		blurb:
			'Record kills, deaths, cash and results per player per match: leaderboards, careers and the current-match table on Discord boards. One row per player per match, kept a year.'
	},
	publicStatus: {
		name: 'Public status page',
		blurb:
			'A page anyone can open without signing in: map, clock, players, scores, cash and the current match, built from the poller’s last sample.'
	},
	publicStats: {
		name: 'Public leaderboards and careers',
		blurb:
			'Public pages for the leaderboard and each player’s career. Needs match statistics; shows nothing an admin wrote (notes, watchlist, risk, bans).'
	}
};

/**
 * Both levels must agree. Public stats also need the stats themselves, otherwise the pages would
 * be empty and misleading.
 */
export function effectiveFeatures(org: OrgAllowances, server: ServerSwitches): Features {
	const stats = org.allowStats && server.statsEnabled;
	return {
		stats,
		publicStatus: org.allowPublicStatus && server.publicStatus,
		publicStats: stats && org.allowPublicStats && server.publicStats
	};
}

/** Why a switched-on feature is still off, for the settings UI; null when it is on or simply off. */
export function featureBlocker(
	key: FeatureKey,
	org: OrgAllowances,
	server: ServerSwitches
): string | null {
	const on = {
		stats: server.statsEnabled,
		publicStatus: server.publicStatus,
		publicStats: server.publicStats
	}[key];
	if (!on) return null;
	const allowed = {
		stats: org.allowStats,
		publicStatus: org.allowPublicStatus,
		publicStats: org.allowPublicStats
	}[key];
	if (!allowed) return 'not allowed for this organisation by the site owner';
	if (key === 'publicStats' && !effectiveFeatures(org, server).stats)
		return 'needs match statistics, which are off';
	return null;
}

/** Absolute links to a server's public pages, only for the pages that are on; the org's Discord too. */
export interface PublicLinks {
	status?: string;
	stats?: string;
	/** the join page, when the status page is on and a join code is set */
	join?: string;
	discord?: string;
}
export function publicLinks(
	origin: string,
	org: OrgAllowances & { discordUrl?: string },
	server: ServerSwitches & { id: string; joinCode?: string }
): PublicLinks {
	const f = effectiveFeatures(org, server);
	const base = `${origin.replace(/\/+$/, '')}/public/${encodeURIComponent(server.id)}`;
	const out: PublicLinks = {};
	if (f.publicStatus) out.status = base;
	if (f.publicStats) out.stats = `${base}/stats`;
	if (f.publicStatus && server.joinCode) out.join = `${base}/join`;
	if (org.discordUrl) out.discord = org.discordUrl;
	return out;
}

export const parseSwitches = (body: Record<string, unknown>): Partial<ServerSwitches> => {
	const out: Partial<ServerSwitches> = {};
	if (body.statsEnabled !== undefined) out.statsEnabled = !!body.statsEnabled;
	if (body.publicStatus !== undefined) out.publicStatus = !!body.publicStatus;
	if (body.publicStats !== undefined) out.publicStats = !!body.publicStats;
	return out;
};

export const parseAllowances = (body: Record<string, unknown>): Partial<OrgAllowances> => {
	const out: Partial<OrgAllowances> = {};
	if (body.allowStats !== undefined) out.allowStats = !!body.allowStats;
	if (body.allowPublicStatus !== undefined) out.allowPublicStatus = !!body.allowPublicStatus;
	if (body.allowPublicStats !== undefined) out.allowPublicStats = !!body.allowPublicStats;
	return out;
};

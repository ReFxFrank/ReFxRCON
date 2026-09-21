import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { discordEnabled, getEnv } from '$lib/server/env';
import { requireOrgRole, type OrgRow } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { listInvites, listMembers } from '$lib/server/orgs';
import { listWebhooks, WEBHOOK_EVENT_LABELS } from '$lib/server/webhooks';
import { listBoards, MAX_TOP_PLAYERS, MIN_INTERVAL_S } from '$lib/server/status-board';
import { pollSeconds } from '$lib/server/env';

/** Org management: owners of the org (and the site owner) only. Same rule as the API routes. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	let org: OrgRow;
	try {
		({ org } = await requireOrgRole(env, locals, params.id, 'owner'));
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
	const [members, invites, webhooks, boards] = await Promise.all([
		listMembers(env, org.id),
		listInvites(env, org.id),
		listWebhooks(env, org.id),
		listBoards(env, org.id)
	]);
	return {
		members,
		invites,
		webhooks,
		webhookEvents: Object.entries(WEBHOOK_EVENT_LABELS).map(([key, label]) => ({ key, label })),
		boards,
		/** the shortest refresh a board may have: the poll interval, and never under half a minute */
		boardMinInterval: Math.max(MIN_INTERVAL_S, pollSeconds(env) || MIN_INTERVAL_S),
		boardMaxTop: MAX_TOP_PLAYERS,
		pollerOn: pollSeconds(env) > 0,
		discord: discordEnabled(env)
	};
};

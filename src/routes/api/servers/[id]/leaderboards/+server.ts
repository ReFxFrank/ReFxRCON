import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { accessibleServers, requireServerRole, requireUser } from '$lib/server/access';
import { loadLeaderboard, parseCareerRange, parseMinMinutes, parseSort } from '$lib/server/career';

/**
 * The board for this server, or (`scope=org`) for every server of its organisation the caller
 * may open, the same set a dossier's history covers.
 */
export const GET = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	const q = event.url.searchParams;
	const scope = q.get('scope') === 'org' ? 'org' : 'server';
	const servers =
		scope === 'org'
			? (await accessibleServers(env, user))
					.filter((s) => s.orgId === server.orgId)
					.map((s) => ({ id: s.id, name: s.name }))
			: [{ id: server.id, name: server.name }];
	return apiJson({
		ok: true,
		...(await loadLeaderboard(env, servers, {
			scope,
			range: parseCareerRange(q.get('range')),
			sort: parseSort(q.get('sort')),
			minMinutes: parseMinMinutes(q.get('min'))
		}))
	});
});

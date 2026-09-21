import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { parseCareerRange, parseMinMinutes, parseSort } from '$lib/server/career';
import { publicLeaderboard, publicRate, publicTarget, requirePublic } from '$lib/server/public';

/** No account needed; 404 unless the server's public stats are on. `scope=org` spans the org's public servers. */
export const GET = route(async (event) => {
	const env = getEnv();
	publicRate(event.request);
	const t = requirePublic(await publicTarget(env, param(event, 'id')), 'publicStats');
	const q = event.url.searchParams;
	return apiJson(
		{
			ok: true,
			...(await publicLeaderboard(env, t, {
				scope: q.get('scope') === 'org' ? 'org' : 'server',
				range: parseCareerRange(q.get('range')),
				sort: parseSort(q.get('sort')),
				minMinutes: parseMinMinutes(q.get('min'))
			}))
		},
		200,
		{ 'cache-control': 'public, max-age=30' }
	);
});

import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { publicRate, publicStatus, publicTarget, requirePublic } from '$lib/server/public';

/** No account needed; 404 unless the server's public status page is on. Cached a few seconds. */
export const GET = route(async (event) => {
	const env = getEnv();
	publicRate(event.request);
	const t = requirePublic(await publicTarget(env, param(event, 'id')), 'publicStatus');
	return apiJson({ ok: true, ...(await publicStatus(env, t)) }, 200, {
		'cache-control': 'public, max-age=5'
	});
});

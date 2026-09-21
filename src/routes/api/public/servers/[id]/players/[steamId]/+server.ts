import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireSteamId } from '$lib/server/steam';
import { publicCareer, publicRate, publicTarget, requirePublic } from '$lib/server/public';

/** A player's career on the org's public servers: match statistics only, nothing an admin wrote. */
export const GET = route(async (event) => {
	const env = getEnv();
	publicRate(event.request);
	const t = requirePublic(await publicTarget(env, param(event, 'id')), 'publicStats');
	const steamId = requireSteamId(param(event, 'steamId'));
	return apiJson({ ok: true, ...(await publicCareer(env, t, steamId)) }, 200, {
		'cache-control': 'public, max-age=30'
	});
});

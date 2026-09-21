import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerRole } from '$lib/server/access';
import {
	loadRotationRetention,
	parseGrouping,
	parseRetentionRange
} from '$lib/server/rotation-retention';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	return apiJson({
		ok: true,
		...(await loadRotationRetention(
			env,
			server.id,
			parseRetentionRange(event.url.searchParams.get('range')),
			parseGrouping(event.url.searchParams.get('by'))
		))
	});
});

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { DEFAULT_MIN_MINUTES } from '$lib/server/career';
import { publicLeaderboard, publicTarget } from '$lib/server/public';

export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || !t.features.publicStats) error(404, 'Not found.');
	return {
		board: await publicLeaderboard(env, t, {
			scope: 'server',
			range: '30d',
			sort: 'kills',
			minMinutes: DEFAULT_MIN_MINUTES
		})
	};
};

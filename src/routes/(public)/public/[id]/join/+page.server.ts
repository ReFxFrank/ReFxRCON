import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicTarget } from '$lib/server/public';
import { steamLaunchLink } from '$lib/server/join';

/** The join page: on with the status page, and only once an org owner set the join code. */
export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || !t.features.publicStatus || !t.server.joinCode) error(404, 'Not found.');
	return { code: t.server.joinCode, launch: steamLaunchLink() };
};

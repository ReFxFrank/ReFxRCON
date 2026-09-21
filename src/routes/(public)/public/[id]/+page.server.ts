import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicStatus, publicTarget } from '$lib/server/public';

/** The first render carries the status so the page paints at once; the page then polls the JSON. */
export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || !t.features.publicStatus) error(404, 'Not found.');
	return { status: await publicStatus(env, t) };
};

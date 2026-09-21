import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicCareer, publicTarget } from '$lib/server/public';
import { steamView } from '$lib/server/players';
import { getProfiles } from '$lib/server/steam';

/** A player's public career: match statistics and the Steam persona and avatar, nothing an admin wrote. */
export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || !t.features.publicStats) error(404, 'Not found.');
	if (!/^\d{17}$/.test(params.steamId)) error(404, 'Not found.');
	const [{ name, career, servers }, profiles] = await Promise.all([
		publicCareer(env, t, params.steamId),
		getProfiles(env, [params.steamId], { cacheOnly: true }).catch(() => new Map())
	]);
	const steam = steamView(profiles.get(params.steamId));
	return {
		steamId: params.steamId,
		name,
		career,
		servers,
		steam: steam
			? { persona: steam.persona, avatar: steam.avatar, profileUrl: steam.profileUrl }
			: null
	};
};

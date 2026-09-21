import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { assertRate } from '$lib/server/ratelimit';
import { refreshBoardNow } from '$lib/server/status-board';

/** Reads the server and posts (or edits) the card right now; the way to try a new board out. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	assertRate(`board-refresh:${user.id}`, 10, 60_000);
	const result = await refreshBoardNow(env, event.request, user, org, param(event, 'boardId'));
	return apiJson({ ok: result.ok, result }, result.ok ? 200 : 502);
});

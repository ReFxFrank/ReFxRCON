// An organisation's Discord invite, shown as a button on its public pages. Pure validation.

const HOSTS = new Set(['discord.gg', 'discord.com', 'www.discord.com', 'discordapp.com']);

/**
 * Accepts `https://discord.gg/<code>` and `https://discord(app).com/invite/<code>`, normalised to
 * the short form; blank clears. Anything else is refused so the button can never point elsewhere.
 */
export function validateDiscordInvite(raw: unknown): string {
	const text = String(raw ?? '').trim();
	if (!text) return '';
	let u: URL;
	try {
		u = new URL(text.includes('://') ? text : `https://${text}`);
	} catch {
		throw new Error('That is not a Discord invite link.');
	}
	const host = u.hostname.toLowerCase();
	const parts = u.pathname.split('/').filter(Boolean);
	const code =
		host === 'discord.gg' && parts.length === 1
			? parts[0]
			: HOSTS.has(host) && parts.length === 2 && parts[0].toLowerCase() === 'invite'
				? parts[1]
				: '';
	if (u.protocol !== 'https:' || !HOSTS.has(host) || !/^[A-Za-z0-9-]{2,64}$/.test(code))
		throw new Error(
			'Paste a Discord invite link: https://discord.gg/<code> (Server settings → Invites, or Invite people → Edit link → never expire).'
		);
	return `https://discord.gg/${code}`;
}

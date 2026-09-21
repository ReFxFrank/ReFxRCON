// The two embeds of a Discord status board, built from what the poller already holds. Pure, so
// it can be tested without a database; status-board.ts owns the records and the delivery.
import type { Embed } from './webhook-delivery';
import { expSetLabel, lightingLabel, MAP_DISPLAY, prettify } from '$lib/format';
import type { Player, Status } from '$lib/types';

export interface MatchPlayer {
	steamId: string;
	name: string;
	faction: string | null;
	kills: number;
	deaths: number;
}

export interface BoardInput {
	appName: string;
	serverName: string;
	/** null when the server could not be reached */
	status: Status | null;
	/** why it could not be reached */
	problem?: string;
	/** connected right now */
	players: Player[];
	/** the open match, if the poller has one */
	match: { startedAt: Date; peakPlayers: number } | null;
	/** everyone seen in the open match, from player_match_stats */
	matchPlayers: MatchPlayer[];
	/** the last 24 hours on this server */
	day: { peak: number; unique: number; matches: number } | null;
	topPlayers: number;
	intervalSeconds: number;
	now: Date;
	/**
	 * Where the card links out: the public status page (the title becomes the link), the public
	 * leaderboard and the org's Discord. A channel webhook cannot carry real buttons (Discord
	 * reserves components for application-owned webhooks), so these are links in the text.
	 */
	links?: { status?: string; stats?: string; join?: string; discord?: string };
}

const EMPTY_CATALOG = { maps: [], lightings: [], experiences: [] };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad = (s: string, n: number) =>
	s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export const clock = (sec: number | null): string => {
	if (sec === null || !Number.isFinite(sec)) return '—';
	const s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h
		? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
		: `${m}:${String(s % 60).padStart(2, '0')}`;
};

/** Discord cannot colour text, so a faction's colour becomes the nearest coloured circle. */
export function colorEmoji(hex: string | null | undefined): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
	if (!m) return '⚪';
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	const swatches: [string, number, number, number][] = [
		['🔴', 216, 96, 96],
		['🔵', 91, 149, 216],
		['🟢', 123, 196, 98],
		['🟡', 230, 200, 70],
		['🟠', 230, 140, 60],
		['🟣', 160, 100, 200],
		['⚪', 220, 220, 220],
		['⚫', 40, 40, 40]
	];
	let best = swatches[0];
	let dist = Infinity;
	for (const s of swatches) {
		const d = (s[1] - r) ** 2 + (s[2] - g) ** 2 + (s[3] - b) ** 2;
		if (d < dist) {
			dist = d;
			best = s;
		}
	}
	return best[0];
}

const hexToInt = (hex: string | null | undefined, fallback: number): number => {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
	return m ? parseInt(m[1], 16) : fallback;
};

const NEUTRAL = 0x8a8a90;
const ACCENT = 0xd4a843;
const DANGER = 0xd86060;

/** The two embeds for one board: the server, then the current match's top players. */
export function buildBoardEmbeds(input: BoardInput): Embed[] {
	const footer = { text: `${input.appName} · updates every ${clock(input.intervalSeconds)}` };
	const timestamp = input.now.toISOString();
	const { status } = input;
	if (!status) {
		return [
			{
				title: clip(input.serverName, 200),
				description: `**Unreachable.** ${clip(input.problem || 'The panel could not reach the game server.', 800)}`,
				color: DANGER,
				timestamp,
				footer
			}
		];
	}
	const scores = [...status.scores].sort((a, b) => b.score - a.score);
	const leader = scores[0];
	const tied = scores.length > 1 && scores[1].score === leader?.score;
	const map = MAP_DISPLAY[status.map] || prettify(status.map) || '—';
	const lines = [
		`**Map** ${map} · ${expSetLabel(EMPTY_CATALOG, status.experiences)}`,
		`**Lighting** ${lightingLabel(EMPTY_CATALOG, status.lighting)}`,
		`**Match clock** ${clock(status.matchSeconds)}${status.scoreCap ? ` · first to ${fmtInt(status.scoreCap)}` : ''}`
	];
	const links = [
		input.links?.join ? `[Join](${input.links.join})` : '',
		input.links?.status ? `[Status page](${input.links.status})` : '',
		input.links?.stats ? `[Leaderboard](${input.links.stats})` : ''
	].filter(Boolean);
	if (links.length) lines.push(`🔗 ${links.join(' · ')}`);
	const cashByFaction = new Map<string, number>();
	for (const p of input.players) {
		const key = p.faction || '';
		cashByFaction.set(key, (cashByFaction.get(key) || 0) + (p.cash || 0));
	}
	const cashTotal = [...cashByFaction.values()].reduce((a, b) => a + b, 0);
	const fields: NonNullable<Embed['fields']> = [
		{
			name: 'Players',
			value: `**${status.playerCount}** / ${status.maxPlayers}${input.match ? `\npeak this match ${Math.max(input.match.peakPlayers, status.playerCount)}` : ''}`,
			inline: true
		},
		{
			name: 'Scores',
			value: scores.length
				? scores
						.map(
							(s, i) =>
								`${colorEmoji(s.colorHex)} ${i === 0 && !tied ? `**${s.name}**` : s.name} ${fmtInt(s.score)}`
						)
						.join('\n')
				: '—',
			inline: true
		},
		{
			name: 'Cash in play',
			value: input.players.length
				? `$${fmtInt(cashTotal)}\n${scores
						.filter((s) => cashByFaction.has(s.name))
						.map((s) => `${colorEmoji(s.colorHex)} $${fmtInt(cashByFaction.get(s.name) || 0)}`)
						.join(' · ')}`.trim()
				: '—',
			inline: true
		}
	];
	if (input.day)
		fields.push({
			name: 'Last 24 h',
			value: `peak ${input.day.peak} · ${input.day.unique} player${input.day.unique === 1 ? '' : 's'} · ${input.day.matches} match${input.day.matches === 1 ? '' : 'es'}`,
			inline: false
		});
	const server: Embed = {
		title: clip(input.serverName, 200),
		...(input.links?.status ? { url: input.links.status } : {}),
		description: lines.join('\n'),
		color: leader && !tied ? hexToInt(leader.colorHex, ACCENT) : NEUTRAL,
		timestamp,
		fields,
		footer
	};

	const online = new Set(input.players.map((p) => p.steamId));
	const ranked = [...input.matchPlayers]
		.filter((p) => p.kills > 0 || p.deaths > 0)
		.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
	const top = ranked.slice(0, Math.max(1, input.topPlayers));
	let body: string;
	if (!input.matchPlayers.length && !input.players.length) body = 'Nobody is playing right now.';
	else if (!ranked.length) body = 'Nobody has scored yet.';
	else {
		const rows = top.map((p, i) => {
			const kd = p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
			const name = clip(p.name, 16) + (online.has(p.steamId) ? '' : '*');
			return `${lpad(String(i + 1), 2)}  ${pad(name, 17)} ${pad(clip(p.faction || '—', 9), 9)} ${lpad(String(p.kills), 3)} ${lpad(String(p.deaths), 3)} ${lpad(kd, 6)}`;
		});
		const left = top.some((p) => !online.has(p.steamId));
		body =
			'```\n' +
			` #  ${pad('Player', 17)} ${pad('Faction', 9)}   K   D    K/D\n` +
			rows.join('\n') +
			'\n```' +
			`${input.matchPlayers.length} in this match · ${ranked.length} scored${left ? ' · * left the server' : ''}`;
	}
	const board: Embed = {
		title: `Current match · top ${Math.min(top.length || input.topPlayers, input.topPlayers)}`,
		description: clip(body, 4000),
		color: ACCENT,
		timestamp,
		footer: {
			text: 'Kills and deaths this match, from RCON. Careers and leaderboards live in the panel.'
		}
	};
	return [server, board];
}

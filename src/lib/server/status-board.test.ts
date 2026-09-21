import { describe, expect, test } from 'bun:test';
import { buildBoardEmbeds, clock, colorEmoji, type BoardInput } from './status-board-embeds';
import type { Status } from '$lib/types';

const now = new Date('2026-09-14T12:00:00Z');
const status: Status = {
	serverName: 'EU #1',
	map: 'Kavkazi',
	experiences: ['Bakurani_KOTH_01', 'KOTH_InfantryOnly'],
	lighting: 'DayLateClear',
	alternator: '',
	scoreTick: 20,
	scoreTickMin: 18,
	scoreTickMax: 30,
	scoreCap: 1000,
	matchSeconds: 1935,
	playerCount: 3,
	maxPlayers: 100,
	scores: [
		{ name: 'Valkyra', colorHex: '#D86060', score: 410 },
		{ name: 'Lonestar', colorHex: '#5B95D8', score: 380 },
		{ name: 'Manticore', colorHex: '#7BC462', score: 120 }
	],
	rotationNow: 0,
	rotationNext: 1
};
const players = [
	{ name: 'Nomad', steamId: '1', faction: 'Lonestar', kills: 5, deaths: 2, cash: 4000, ping: 30 },
	{ name: 'Ghost', steamId: '2', faction: 'Valkyra', kills: 9, deaths: 4, cash: 1500, ping: 30 },
	{ name: 'Newbie', steamId: '3', faction: 'Valkyra', kills: 0, deaths: 0, cash: 10000, ping: 30 }
];
const base: BoardInput = {
	appName: 'Warcon',
	serverName: 'EU #1',
	status,
	players,
	match: { startedAt: new Date(now.getTime() - 1935_000), peakPlayers: 40 },
	matchPlayers: [
		{ steamId: '2', name: 'Ghost', faction: 'Valkyra', kills: 9, deaths: 4 },
		{ steamId: '1', name: 'Nomad', faction: 'Lonestar', kills: 5, deaths: 2 },
		{
			steamId: '9',
			name: 'A very long player name indeed',
			faction: 'Manticore',
			kills: 5,
			deaths: 0
		},
		{ steamId: '3', name: 'Newbie', faction: 'Valkyra', kills: 0, deaths: 0 }
	],
	day: { peak: 88, unique: 312, matches: 14 },
	topPlayers: 10,
	intervalSeconds: 60,
	now
};

describe('clock', () => {
	test('minutes and hours', () => {
		expect(clock(65)).toBe('1:05');
		expect(clock(3725)).toBe('1:02:05');
		expect(clock(null)).toBe('—');
	});
});

describe('colorEmoji', () => {
	test('maps faction colours to the nearest circle', () => {
		expect(colorEmoji('#D86060')).toBe('🔴');
		expect(colorEmoji('#5B95D8')).toBe('🔵');
		expect(colorEmoji('#7BC462')).toBe('🟢');
		expect(colorEmoji('nope')).toBe('⚪');
	});
});

describe('buildBoardEmbeds', () => {
	test('server embed: map, clock, players, scores with the leader in bold, cash, last 24 h', () => {
		const [server, board] = buildBoardEmbeds(base);
		expect(server.title).toBe('EU #1');
		expect(server.description).toContain('**Map** Bakurani · King of the Hill + Infantry Only');
		expect(server.description).toContain('**Match clock** 32:15 · first to 1,000');
		expect(server.color).toBe(0xd86060);
		const field = (name: string) => server.fields!.find((f) => f.name === name)!.value;
		expect(field('Players')).toBe('**3** / 100\npeak this match 40');
		expect(field('Scores')).toBe('🔴 **Valkyra** 410\n🔵 Lonestar 380\n🟢 Manticore 120');
		expect(field('Cash in play')).toContain('$15,500');
		expect(field('Cash in play')).toContain('🔴 $11,500');
		expect(field('Last 24 h')).toBe('peak 88 · 312 players · 14 matches');
		expect(server.footer?.text).toBe('Warcon · updates every 1:00');
		expect(board.title).toBe('Current match · top 3');
	});
	test('leaderboard embed: ranked by kills, clipped names, a star for players who left', () => {
		const [, board] = buildBoardEmbeds(base);
		const lines = board.description.split('\n');
		expect(lines[0]).toBe('```');
		expect(lines[2]).toMatch(/^ 1  Ghost {13}Valkyra {3}  9   4   2\.25$/);
		// same kills as Nomad but fewer deaths, so second; the name is clipped and starred (left)
		expect(lines[3]).toMatch(/^ 2  A very long pla…\* Manticore {3}5   0 {3}5\.00$/);
		expect(lines[4]).toMatch(/^ 3  Nomad {13}Lonestar {2}  5   2   2\.50$/);
		expect(board.description).toContain('4 in this match · 3 scored · * left the server');
		// Newbie has no kills or deaths and does not take a row
		expect(board.description).not.toContain('Newbie');
	});
	test('deaths break ties on kills, fewer first', () => {
		const [, board] = buildBoardEmbeds(base);
		const idxLong = board.description.indexOf('A very long');
		const idxNomad = board.description.indexOf('Nomad');
		expect(idxLong).toBeLessThan(idxNomad);
	});
	test('respects the row limit', () => {
		const [, board] = buildBoardEmbeds({ ...base, topPlayers: 1 });
		expect(board.title).toBe('Current match · top 1');
		expect(board.description).toContain('Ghost');
		expect(board.description).not.toContain('Nomad');
	});
	test('an empty server and a match nobody has scored in', () => {
		expect(buildBoardEmbeds({ ...base, players: [], matchPlayers: [] })[1].description).toBe(
			'Nobody is playing right now.'
		);
		expect(
			buildBoardEmbeds({
				...base,
				matchPlayers: [{ steamId: '3', name: 'Newbie', faction: 'Valkyra', kills: 0, deaths: 0 }]
			})[1].description
		).toBe('Nobody has scored yet.');
	});
	test('a tie at the top has no bold leader and a neutral colour', () => {
		const tied = {
			...status,
			scores: [
				{ name: 'A', colorHex: '#D86060', score: 5 },
				{ name: 'B', colorHex: '#5B95D8', score: 5 }
			]
		};
		const [server] = buildBoardEmbeds({ ...base, status: tied });
		expect(server.fields![1].value).toBe('🔴 A 5\n🔵 B 5');
		expect(server.color).toBe(0x8a8a90);
	});
	test('links: the title opens the status page and a line points at the leaderboard', () => {
		const [server] = buildBoardEmbeds({
			...base,
			links: { status: 'https://h/public/x', stats: 'https://h/public/x/stats' }
		});
		expect(server.url).toBe('https://h/public/x');
		expect(server.description).toContain(
			'🔗 [Status page](https://h/public/x) · [Leaderboard](https://h/public/x/stats)'
		);
		expect(
			buildBoardEmbeds({ ...base, links: { join: 'https://h/public/x/join' } })[0].description
		).toContain('🔗 [Join](https://h/public/x/join)');
		const [plain] = buildBoardEmbeds(base);
		expect(plain.url).toBeUndefined();
		expect(plain.description).not.toContain('🔗');
	});
	test('unreachable: one red embed with the problem', () => {
		const embeds = buildBoardEmbeds({ ...base, status: null, problem: 'Connection refused.' });
		expect(embeds).toHaveLength(1);
		expect(embeds[0].description).toBe('**Unreachable.** Connection refused.');
		expect(embeds[0].color).toBe(0xd86060);
	});
	test('stays inside Discord limits', () => {
		const many = Array.from({ length: 200 }, (_, i) => ({
			steamId: String(i),
			name: `Player number ${i} with a long name`,
			faction: 'Manticore',
			kills: 200 - i,
			deaths: i
		}));
		const [, board] = buildBoardEmbeds({ ...base, matchPlayers: many, topPlayers: 25 });
		expect(board.description.length).toBeLessThanOrEqual(4096);
		expect(board.description.split('\n').length).toBe(25 + 3);
	});
});

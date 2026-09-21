/**
 * DEVELOPMENT ONLY. Writes synthetic matches and samples for one server so the rotation
 * retention panel can be checked against data whose ground truth is known.
 *
 * The mock game server in src/lib/server/mockgame.ts is no use for this: players drift in and
 * never leave, so no map ever bleeds and the panel has nothing to find. This generates a
 * rotation with a deliberate loser, the same two confounds the estimator exists to remove
 * (time of day, and mean reversion from a high start), and a weighted rotation so the
 * self-baseline failure would show up if it were still there.
 *
 *   DATABASE_URL=postgres://... bun run scripts/seed-rotation-retention.ts <server-id> [days]
 *
 * It refuses to run against a server that already holds samples OR matches, so it cannot
 * quietly corrupt a live one. Undo with:
 *   DELETE FROM samples WHERE server_id = '<id>'; DELETE FROM matches WHERE server_id = '<id>';
 */
import { SQL } from 'bun';

const [serverId, daysArg] = process.argv.slice(2);
if (!serverId) {
	console.error('usage: bun run scripts/seed-rotation-retention.ts <server-id> [days]');
	process.exit(1);
}
const DAYS = Number(daysArg ?? 30);
if (!Number.isFinite(DAYS) || DAYS <= 0) {
	// Without this a typo seeds nothing and exits 0, which reads as success.
	console.error(`days must be a positive number, got ${JSON.stringify(daysArg)}`);
	process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set.');
	process.exit(1);
}

/**
 * Ground truth, in players gained over the first ten minutes.
 *
 * These are INTERNAL map ids, which is what the database stores and what the panel runs through
 * mapLabel(). The first three are the mock server's, and they display as Bakurani, Ozeti and
 * Zestafona -- note that the display names of some maps are the internal ids of others, so a
 * fixture that uses display names here produces duplicate rows in the panel and looks like a
 * bug in the chart when it is a bug in the fixture.
 */
const SPECS = [
	{ map: 'Kavkazi', weight: 3, effect: 0 },
	{ map: 'Europe', weight: 1, effect: 0.5 },
	{ map: 'NorthAmerica', weight: 1, effect: -1.5 },
	{ map: 'Caucasus_Ridge', weight: 1, effect: 1 },
	{ map: 'Talinn_Docks', weight: 1, effect: -4 }
];
const CAP = 64;
const POLL_S = 20;
const MATCH_MIN = 20;

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
const rand = rng(20260921);

/** Population norm by hour, with a weekend lift; the time-of-day confound. */
const norm = (hour: number, weekend: boolean) =>
	14 + 22 * Math.exp(-((hour - 20) ** 2) / 40) + (weekend ? 5 : 0);
/** What the hour itself does to the ten-minute delta, independent of the map. */
const slotEffect = (hour: number) =>
	hour >= 16 && hour < 22 ? 1.6 : hour >= 2 && hour < 10 ? -1.9 : 0.1;

const client = new SQL(url, { max: 4 });

// Samples are pruned at 90 days and matches at 365, so a real server that has been quiet for a
// season holds matches and no samples at all. Counting only samples would wave that through.
const [{ n: existing }] = await client`
	SELECT (SELECT COUNT(*) FROM samples WHERE server_id = ${serverId})
	     + (SELECT COUNT(*) FROM matches WHERE server_id = ${serverId}) AS n`;
if (Number(existing) > 0) {
	console.error(
		`server ${serverId} already holds ${existing} samples/matches. Refusing to mix synthetic data into it.`
	);
	process.exit(1);
}
const [srv] = await client`SELECT name FROM servers WHERE id = ${serverId}`;
if (!srv) {
	console.error(`no server with id ${serverId}`);
	process.exit(1);
}

/**
 * A map that only ran a handful of times. It exists so the fixture exercises the sub-threshold
 * path: below MIN_MATCHES a map must show its count and no residual, rather than a zero bar
 * that reads as "this map is fine".
 */
const RARE = { map: 'Verdun_Night', effect: -6, matches: 12 };

const wheel: typeof SPECS = [];
for (const s of SPECS) for (let i = 0; i < s.weight; i++) wheel.push(s);

const matchRows: { startedAt: Date; endedAt: Date; map: string }[] = [];
const sampleRows: { ts: Date; playerCount: number; map: string }[] = [];

const end = Date.now();
const start = end - DAYS * 86400_000;
let t = start;
let i = 0;
let rareLeft = RARE.matches;
while (t < end) {
	const spec = wheel[i % wheel.length];
	i++;
	const startedAt = new Date(t);
	const endedAt = new Date(t + MATCH_MIN * 60_000);
	t += MATCH_MIN * 60_000;
	const hour = startedAt.getUTCHours();
	const weekend = startedAt.getUTCDay() === 0 || startedAt.getUTCDay() === 6;
	const n = norm(hour, weekend);
	const ccuStart = Math.max(1, Math.min(CAP - 2, Math.round(n + (rand() - 0.5) * 12)));
	const excess = ccuStart - n;
	// Swap in the rare map on a fixed, widely spaced set of slots so it lands on varied hours.
	const useRare = rareLeft > 0 && i % 173 === 0;
	if (useRare) rareLeft--;
	const map = useRare ? RARE.map : spec.map;
	const effect = useRare ? RARE.effect : spec.effect;

	const delta = effect + slotEffect(hour) - 0.35 * excess + (rand() - 0.5) * 2.2;
	const ccu10 = Math.max(0, Math.min(CAP, Math.round(ccuStart + delta)));

	matchRows.push({ startedAt, endedAt, map });

	// Samples every POLL_S across the match, walking linearly from ccuStart to ccu10 and on.
	for (let s = 0; s < (MATCH_MIN * 60) / POLL_S; s++) {
		const at = new Date(startedAt.getTime() + s * POLL_S * 1000);
		const mins = (s * POLL_S) / 60;
		const v =
			mins <= 10 ? ccuStart + ((ccu10 - ccuStart) * mins) / 10 : ccu10 + (rand() - 0.5) * 1.5;
		sampleRows.push({ ts: at, playerCount: Math.max(0, Math.round(v)), map });
	}
}

console.log(
	`seeding ${matchRows.length} matches and ${sampleRows.length} samples over ${DAYS} days into "${srv.name}"…`
);

await client.begin(async (tx) => {
	for (let k = 0; k < matchRows.length; k += 500) {
		const chunk = matchRows.slice(k, k + 500);
		await tx`INSERT INTO matches ${tx(
			chunk.map((m) => ({
				server_id: serverId,
				started_at: m.startedAt,
				ended_at: m.endedAt,
				map: m.map,
				experiences: 'KOTH',
				lighting: 'Day',
				peak_players: CAP
			}))
		)}`;
	}
	for (let k = 0; k < sampleRows.length; k += 2000) {
		const chunk = sampleRows.slice(k, k + 2000);
		await tx`INSERT INTO samples ${tx(
			chunk.map((s) => ({
				ts: s.ts,
				server_id: serverId,
				ok: true,
				player_count: s.playerCount,
				max_players: CAP,
				map: s.map,
				experiences: 'KOTH',
				latency_ms: 20
			}))
		)}`;
	}
});

const unweighted = SPECS.reduce((a, s) => a + s.effect, 0) / SPECS.length;
console.log('\nground truth, centred on the unweighted map average:');
for (const s of [...SPECS].sort((x, y) => x.effect - y.effect)) {
	console.log(`  ${s.map.padEnd(14)} ${(s.effect - unweighted).toFixed(2).padStart(6)}`);
}
console.log(
	`  ${RARE.map.padEnd(14)}  ${RARE.matches} matches only -- must show its count and NO residual`
);
console.log('\ndone. The panel should rank these in this order, worst first.');
await client.close();

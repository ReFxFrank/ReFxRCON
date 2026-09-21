# Phase 2: Live connection

**Goal:** every live WARDOGS server sampling reliably, with the data verified against reality
rather than assumed. Phase 2 ends when a 48-hour soak has passed acceptance and the numbers in
`player_sessions`, `matches` and `player_match_stats` have been checked against a scoreboard you
looked at yourself.

> **Nothing in this runbook has been run end to end.** It was written without a VPS, without a
> live xREALM RCON endpoint and without a deployment target. What *is* verified: every file path,
> line number, constant, default, error string, log line and SQL column name below was read out of
> this repository at the commit you have checked out, and the `POLL_SECONDS` coercion table was
> produced by executing that function. What is *not* verified: the provisioning, the network path
> from the VPS to the xREALM listener, the behaviour of any particular live game build, and the
> deploy itself. Treat the commands as a plan to execute and check, not as a transcript.

## What Phase 0 must have given you

| From Phase 0 | Used here for |
| --- | --- |
| `limits.maxRequestsPerMinutePerIp` for the xREALM listeners | Sizing the poll budget before the fourth server is added |
| Whether the four servers share one front-end IP or rate-limit bucket | Deciding whether the budget is per server or summed |
| Host, port and scheme of each listener | The **Servers → Add server** form |
| The RCON password for each | The same form; encrypted at rest immediately |
| The VPS's egress IP | The address the game side will see; every request comes from it |

If Phase 0 did not record the rate limit, get it before adding the fourth server. The panel does
not read it, does not throttle itself, and does not back off on a `429` — a rate-limited poll is
just a failed poll (see [Kill criteria](#kill-criteria)).

## 1. The request budget

### What one tick actually costs

The brief for this phase estimated roughly 7 requests per minute per server at
`POLL_SECONDS=20`. Read against `src/lib/server/poller.ts` the real figure is **6.4**. The working
is below; use the real figure.

`pollServer` (`src/lib/server/poller.ts:155-269`) makes exactly two game calls on a normal tick:

| Line | Call | Route |
| --- | --- | --- |
| `poller.ts:167` | `ACTIONS.status.run` | `GET /v1/status` (`actions.ts:85`) |
| `poller.ts:168` | `ACTIONS.players.run` | `GET /v1/players` (`actions.ts:157`) |

They are awaited in order, so they are sequential within one server. `pollAll`
(`poller.ts:147-153`) runs every server concurrently through `Promise.all`, so across four servers
a tick is four near-simultaneous `/v1/status` calls followed by four `/v1/players` calls.

Everything else on the tick is conditional:

| Work | When it costs a game call | Cost |
| --- | --- | --- |
| `refreshLists` (`poller.ts:221`, body at `poller.ts:276-289`) | Only once `LISTS_TTL_MS` has elapsed — `5 * 60_000`, `poller.ts:50`, tested at `poller.ts:283` | `GET /v1/bans` + `GET /v1/reserved-slots`, in parallel (`lists-sync.ts:245-249`) |
| `reconcileServer` (`poller.ts:227`) | Only when a list actually needs pushing. With no work it returns at `lists-sync.ts:396-405` **before** a client is constructed | 0 on a quiet server |
| `refreshBoards` (`poller.ts:240`) | Never — Discord webhooks, not the game server | 0 |
| `runTriggers` (`poller.ts:255`) | Only when a trigger fires (`triggers.ts:241-249`) | 0 with no triggers configured |
| `WardogsClient.forServer` (`poller.ts:166`) | Never — a DNS check at most once per 60 s per host (`rcon.ts:113`, `rcon.ts:125`) | 0 |

### The arithmetic

At `POLL_SECONDS=20`:

```
ticks per minute            60 / 20                    = 3
status + players            3 x 2                      = 6.0 req/min
ban list + reserved slots   2 per 300 s                = 0.4 req/min
                                                    -------------
per server                                               6.4 req/min
four servers                4 x 6.4                    = 25.6 req/min
```

All of it leaves the VPS from one address, so if the four listeners sit behind a shared front end
or a shared rate-limit bucket, that bucket sees **25.6/min**. If each listener limits
independently, each sees **6.4/min**. Phase 0 recorded which it is; that is the number to compare
against `limits.maxRequestsPerMinutePerIp`.

**Check this before adding the fourth server, not after.** A poll that is rate-limited becomes a
`GameError` caught at `poller.ts:169`, written as an `ok = false` row in `samples` with the game's
own message in `samples.error`. Three consecutive failures close every open session on that server
(`poller.ts:179`), so a rate limit does not just dent the ok rate — it fabricates session ends.

If the budget is tight, `POLL_SECONDS=30` costs `2 x 2 + 0.4 = 4.4 req/min/server`, and
`POLL_SECONDS=60` costs `2.4`. Raising the interval costs resolution in `matches` and
`player_sessions`, not correctness.

## 2. Build drift: branch on capabilities, not on 404s

WARDOGS server builds differ in which write routes they expose. Reported drift on the 2026-09-14
build (`++Wardogs+Live-CL-501228`) removes eight write endpoints and moves reserved slots, rotation
editing, the score period and the sponsor banner into the config document. **This repository
contains no record of that build.** Greps for `501228`, `Live-CL` and `gameThreadQueue` across
`src/`, `docs/` and `README.md` return nothing, and the route table in `docs/wardogs-api.md` was
reverse-engineered on 2026-09-08, before that date. So treat the specific list as unverified here
and establish it per server from the server itself.

### What the codebase already does

Feature detection goes through `ACTIONS.capabilities` (`src/lib/server/actions.ts:131-151`). It
reads `GET /v1/capabilities`, normalises each advertised route by replacing `{param}` and `:param`
segments with `*` (`actions.ts:136-141`), and derives exactly two flags:

```ts
features: {
    changeTeam: routes.includes('PATCH /v1/players/*'),
    configDocument: routes.includes('PUT /v1/config') && !!data.config?.writable
}
```

Two call sites tolerate the route being absent entirely, which is how an older build is handled:

- `src/routes/(app)/server/[id]/+layout.server.ts:20` defaults to
  `{ changeTeam: false, configDocument: false }`, then `:26-30` wraps the capabilities call in a
  `try`/`catch` whose only body is the comment `/* older plugin builds have no capabilities route */`.
  The panel renders with both features off rather than failing the page.
- `src/lib/server/servers.ts:252-257` does the same in `testServer`, leaving `capabilities` as
  `null`. The Servers page prints what came back — route count and both flags — at
  `src/routes/(app)/servers/+page.svelte:426-429`.

The `Features` type is those two fields and nothing else (`src/lib/types.ts:56-59`).

### The gap to record

The panel branches on **two** capabilities. Every other write action in `ACTIONS` is called
unconditionally, and a route the build no longer serves comes back as a non-2xx, which `rcon.ts:84-91`
turns into a `GameError` carrying the game's own message. Unconditionally-called write routes:

| Action | Route |
| --- | --- |
| `broadcast`, `whisper`, `kick`, `kill` | `POST /v1/broadcast`, `POST /v1/players/{id}/message`, `.../kick`, `.../kill` |
| `endMatch`, `restartMatch`, `changeMap` | `POST /v1/match/end`, `/restart`, `/map` |
| `setWeather` | `PUT /v1/world/lighting` |
| `rotationAdd`, `rotationRemove`, `rotationMove`, `rotationReorder`, `setNextMap` | `POST`/`DELETE` on `/v1/rotation/entries...` |
| `rotationSave` | `POST /v1/rotation/save` |
| `ban`, `unban` | `POST /v1/bans`, `DELETE /v1/bans/{id}` |
| `reservedAdd`, `reservedRemove` | `POST /v1/reserved-slots`, `DELETE /v1/reserved-slots/{id}` |
| `settings` | `PATCH /v1/settings` |
| `setSponsor` | `PUT /v1/sponsor` |

So the procedure for each server is: **read its advertised routes and compare them against that
list**, rather than discovering the difference when a moderator presses a button.

```bash
# In the panel: Servers -> Test on each server. The result line prints
#   "<N> routes; change team yes|no; config document yes|no"
# For the full list, use the admin-only raw action (actions.ts:547-579), which is
# restricted to /v1/ paths by gamePath() (hostpolicy.ts:168-181) and fully audited.
```

Record the route count and the two flags per server in the Phase 2 notes. Where a write route is
missing and the build has `configDocument: true`, the replacement path is the config document:
`ACTIONS.configValidate` (dry run, `actions.ts:495-507`) then `ACTIONS.configApply`
(`actions.ts:508-545`), which sends `text/plain` with `If-Match: "<revision>"` and treats `412` as
a revision conflict rather than an error (`rcon.ts:97-109`, `actions.ts:114`).

The ini keys that matter for the moved features are in `docs/wardogs-api.md`: `MaxReservedSlots`
and `+DefaultReservedPlayerIds` under `[/Script/WDGame.WDGameSession]`, `+RotationEntries` under
`[/Script/WDGame.WDServerMapRotationSettings]`, `ScorePeriod` under `[MatchState.Playing.KOTH]`,
and `ServerImageURL` for the banner.

**Do not adapt by catching 404s.** A 404 from a route that exists but was mistyped and a 404 from a
route the build removed are the same response; only `/v1/capabilities` distinguishes them.

## 3. Adding the servers

Create the organisation first: **Orgs → New organisation** (or rename the **Default** organisation
every install starts with). Servers belong to exactly one org (`schema.ts:192-194`) and the org is
what carries the feature allowances, so adding servers to the wrong org means moving them later.

Then **Servers → Add server** for each: name, host, port, scheme, RCON password. Use **Test**
before saving another one.

| Field | Constraint | Where |
| --- | --- | --- |
| name | required, ≤ 80 chars | `servers.ts:61-64` |
| host | lowercased, normalised, ≤ 253 chars | `servers.ts:65-68` |
| port | 1-65535; WDRCON default is 7776 | `servers.ts:69-72`, `docs/wardogs-api.md` |
| scheme | anything but `https` becomes `http` | `servers.ts:73-74` |
| password | the RCON bearer token; encrypted before insert | `servers.ts:157` |

The password is AES-256-GCM encrypted at rest under `ENCRYPTION_KEY` and stored in
`servers.password_enc` (`schema.ts:201-202`). The blob format is `v1.<base64 iv>.<base64
ciphertext||tag>` with a 12-byte IV (`crypto.ts:46-51`). The key must base64-decode to exactly 32
bytes or `encryptionKey()` throws
`ENCRYPTION_KEY secret is missing or is not base64 of 32 bytes. Set it in .env (openssl rand -base64 32).`
(`crypto.ts:34-44`).

Two failure modes to have closed before you start typing passwords:

- **An unset `ENCRYPTION_KEY` does not stop the process booting.** `src/hooks.server.ts:33-35`
  only validates it when it is set; otherwise it logs
  `[warcon] ENCRYPTION_KEY is not set; servers cannot be added.` and carries on. `/api/health`
  still returns 200. The failure appears as a 500 the first time you press Save. Grep the startup
  log for that line before adding anything.
- **A private or link-local target is refused.** `assertReachableTarget`
  (`hostpolicy.ts:140-162`) resolves the host and checks every returned address. Link-local
  (`169.254.0.0/16`, `fe80::/10`) is refused for everyone with no override. Private is refused
  unless the *saving user* is the site owner (`servers.ts:46`, `servers.ts:83-87`), and the
  allowance is then baked onto the row as `servers.allow_private`, not re-evaluated per request.
  Tailscale's `100.64.0.0/10` counts as private via the carrier-grade NAT branch
  (`hostpolicy.ts:28`), which is the surprise most people hit. If xREALM is reached over a tunnel,
  the site owner must be the one to add the server.

After saving each server, rotate the RCON password if D1 was resolved as "proceed cleartext". The
password travels as a bearer token on every request over plain HTTP (`rcon.ts:50`,
`transport.ts:39`) — roughly 4,300 transmissions per server per day at `POLL_SECONDS=20`.

## 4. `STEAM_API_KEY` (D5)

Set it. Without it the panel still gets each player's **in-game** display name — `/v1/players`
returns `{name, steamId, faction, kills, deaths, cash, pingMs}` and `actions.ts:159-167` keeps
`name` — but nothing from Steam. The brief for this phase says `/v1/players` gives "SteamID64s and
nothing else"; the in-game name is in fact present. What is missing without the key is everything
in `steam_profiles`: persona name, avatar, profile URL, account creation date, VAC bans, game bans,
community ban and economy ban (`schema.ts:427-442`).

`steamEnabled(env)` is a bare `!!env.STEAM_API_KEY` (`src/lib/server/steam.ts:15`). It gates:

| Reader | Effect when the key is absent |
| --- | --- |
| `poller.ts:250-254` | Joiners' profiles are not warmed, so the players table has nothing cached to show |
| `players.ts:181-189`, `players.ts:265` | Players table and the dossier fall back to whatever is already cached |
| `players.ts:158-170` (`riskFor`) → `risk.ts:51-55` | Risk is scored from local signals only; `Risk.steamChecked` is false, so a "low" means "nothing local", not "clean" (`risk.ts:38-39`) |
| `triggers.ts:394`, `triggers.ts:517`, `triggers.ts:536-539` | The risk-kick trigger skips VAC, game-ban and account-age rules and says so: `Steam lookup is off (STEAM_API_KEY): the VAC, game-ban and account-age rules were skipped.` |
| `career.ts:171`, `lists.ts:148-150` | Career pages and list entries show SteamID64s where a persona would go |

The key is read once in `fetchSteam` (`steam.ts:68`) and used for both
`ISteamUser/GetPlayerSummaries/v2/` and `ISteamUser/GetPlayerBans/v1/` (`steam.ts:81-88`), in
chunks of 100 ids (`steam.ts:12`). Cached rows are refreshed after 24 hours (`steam.ts:11`). A
`429` or `5xx` from Steam sets a 60-second process-wide backoff (`steam.ts:13`, `steam.ts:58-61`);
a `401`/`403` raises `Steam refused the configured API key.` (`steam.ts:56-57`), which is the error
to look for if persona names never appear.

Public pages never spend the quota — they pass `cacheOnly` (`steam.ts:155-156`).

## 5. `POLL_SECONDS` (D9)

Default 20, floor 5, and `0` disables the poller entirely. The whole of it is
`src/lib/server/env.ts:58-61`:

```ts
const n = Number(env.POLL_SECONDS ?? 20);
return Number.isFinite(n) && n > 0 ? Math.max(5, Math.floor(n)) : 0;
```

Coercion, produced by running that function:

| `POLL_SECONDS` | Result | Note |
| --- | --- | --- |
| unset | `20` | the shipped default |
| `''` (empty) | `0` | **poller off** — a commented-out line that still assigns an empty value |
| `'0'` | `0` | poller off |
| `'1'` | `5` | raised silently to the floor |
| `'3'` | `5` | raised silently to the floor |
| `'20'` | `20` | |
| `'30'` | `30` | |
| `'abc'` | `0` | **poller off** |
| `'7.9'` | `7` | floored |
| `'-4'` | `0` | **poller off** |

A value of `0` is not a quiet degradation. With the poller off there is no sampling, no session
tracking, no match tracking, no trigger engine, no Discord status boards, no timed list sync and no
`prune()` — on plain Postgres `samples`, `player_sessions`, `player_match_stats` and `matches` then
grow without bound (`poller.ts:551-563`). The only signal is one log line:
`[warcon] analytics poller disabled (POLL_SECONDS=0)` (`poller.ts:131`).

Keep D9 at 20 for this phase unless the budget in §1 says otherwise. Confirm it took effect by
finding `[warcon] analytics poller every 20s` (`poller.ts:144`) in the startup log — the number in
that line is the coerced value, so it is the one place the coercion is visible.

## 6. The ground-truth check

This is the heart of Phase 2. Everything downstream — leaderboards, careers, rotation retention,
Discord boards — is built on these three tables, and an error here is invisible until it has
polluted weeks of history.

Join one server yourself, play through at least one match boundary, then leave. Keep your own
SteamID64 and the panel's server id to hand:

```bash
psql "$DATABASE_URL" -c "SELECT id, name, host, port, scheme, stats_enabled FROM servers ORDER BY name;"
```

`player_match_stats` is written only where match statistics are on at **both** levels —
`organizations.allow_stats` and `servers.stats_enabled`, combined by `effectiveFeatures`
(`features.ts:47-54`) and consulted at `poller.ts:214` and `poller.ts:405`. Both default to `true`
(`schema.ts:136`, `schema.ts:208`), so a fresh org and server are fine; confirm rather than assume,
because check 2 reads an empty table otherwise.

### Check 1 — you appear within one poll interval

```sql
SELECT id, steam_id, name, faction, joined_at, last_seen, left_at,
       kills, deaths, raw_kills, raw_deaths
  FROM player_sessions
 WHERE server_id = '<server id>'
   AND steam_id  = '<your SteamID64>'
 ORDER BY joined_at DESC
 LIMIT 5;
```

Expect one row with `left_at IS NULL` and `last_seen` advancing by roughly `POLL_SECONDS` each time
you re-run it. A join is only picked up on the tick after you connect, so allow up to one full
interval; the first tick of a process fires 2 s after startup and every `POLL_SECONDS` thereafter
(`poller.ts:142-143`).

If no row appears at all, check that this process is the leader — `[warcon] this instance is the
analytics poller` (`poller.ts:118`) — before suspecting the query.

### Check 2 — kills and deaths track the scoreboard across a match boundary

Look at the in-game scoreboard immediately before the match ends, and again a few minutes into the
next one. Then:

```sql
SELECT m.id AS match_id, m.map, m.started_at, m.ended_at, m.winner, m.peak_players,
       s.faction, s.kills, s.deaths, s.result
  FROM player_match_stats s
  JOIN matches m ON m.id = s.match_id
 WHERE s.server_id = '<server id>'
   AND s.steam_id  = '<your SteamID64>'
 ORDER BY m.started_at DESC
 LIMIT 4;
```

Two things must hold. First, your per-match `kills`/`deaths` must match each scoreboard reading —
not the running total across both matches. Second, the *session* row from check 1 must hold the
sum, because a session accumulates across match boundaries while match rows do not.

This is the property the increment logic exists for. The game reports kills and deaths as counters
that reset when a match starts and when a player reconnects, so the panel stores increments over
the previous reading rather than absolutes (`match-track.ts:1-20`, applied at `poller.ts:373-374`
and accumulated at `poller.ts:382-386`). `counterDelta` (`match-track.ts:16-20`) treats a drop as a
reset and counts the whole new reading. On the sample that begins a match, `fresh` is true and the
baseline is dropped entirely (`poller.ts:363-372`), so the reading *is* the increment.

A single check across one boundary is the minimum. Two boundaries is better, because the failure
mode — a baseline that is off by one match — looks correct inside a single match.

### Check 3 — leaving closes the session

Disconnect, wait one poll interval, then:

```sql
SELECT id, steam_id, joined_at, last_seen, left_at,
       (left_at = last_seen) AS closed_at_last_seen,
       left_at - joined_at   AS duration
  FROM player_sessions
 WHERE server_id = '<server id>'
   AND steam_id  = '<your SteamID64>'
 ORDER BY joined_at DESC
 LIMIT 1;
```

Expect `left_at` to be non-null and `closed_at_last_seen` to be `true`. A player who is simply gone
from `/v1/players` is closed on the next successful tick at their `last_seen`, not at "now"
(`poller.ts:451-456`), so the duration never includes time the panel could not see them.

### Check 4 — persona names resolved

```sql
SELECT steam_id, persona, account_created_at, vac_bans, game_bans, fetched_at, error
  FROM steam_profiles
 WHERE steam_id = '<your SteamID64>';
```

A row with a non-empty `persona` means `STEAM_API_KEY` is working end to end. An empty `persona`
with `error = 'Not found on Steam.'` means Steam answered but did not know the id
(`steam.ts:109`); no row at all means the key is unset or the lookup never ran.

## 7. Soak for 48 hours

Leave it alone for two full days before touching anything visual. Two reasons, and both are worth
the wait:

- **Phase 5 needs history.** Rotation retention needs about 20 matches per map before it will score
  one at all (`docs/refx/rotation-retention.md`), and every leaderboard and career page is built
  from `player_match_stats`. Accumulating that history costs nothing but time, and this is the
  cheapest time to spend it — before anyone is looking at the panel.
- **A 48-hour window is the shortest one that contains a full daily cycle plus a repeat.** A
  problem that only appears at peak, or only during the nightly empty period, will not show up in
  a two-hour look.

Do UI work against the demo server during the soak instead (`ALLOW_DEMO_SERVER=true`, host `demo`,
password `demo`, served by `src/lib/server/mockgame.ts`). Never against live sampling: a restart to
pick up a style change restarts the poller, which resets the per-server in-memory state
(`poller.ts:70-87`) including the failure counter and `firstTick`.

Set `ALLOW_DEMO_SERVER=false` explicitly in the production `.env` when the soak is over. It
defaults **on** (`env.ts:156` is `processEnv.ALLOW_DEMO_SERVER ?? 'true'`) and a demo-host server
bypasses the host policy check entirely (`servers.ts:67`, `servers.ts:86`).

## 8. Acceptance

All five must hold before Phase 2 is done.

### Sustained ok rate above 99% per server across 48 h

```sql
SELECT server_id, avg(ok::int) FROM samples WHERE ts > now() - interval '48 hours' GROUP BY 1;
```

A more readable form, with the sample count so you can tell 99% of 12,000 from 99% of 12:

```sql
SELECT s.server_id,
       v.name,
       count(*)                                   AS samples,
       round(avg(s.ok::int)::numeric, 4)          AS ok_rate,
       count(*) FILTER (WHERE NOT s.ok)           AS failures
  FROM samples s
  JOIN servers v ON v.id = s.server_id
 WHERE s.ts > now() - interval '48 hours'
 GROUP BY 1, 2
 ORDER BY ok_rate ASC;
```

At `POLL_SECONDS=20` a full 48 hours is 8,640 samples per server, so 99% allows 86 failures.

### `latency_ms` p95 under 500 ms

```sql
SELECT server_id,
       count(*)                                                        AS samples,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)        AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)        AS p95_ms,
       max(latency_ms)                                                 AS max_ms
  FROM samples
 WHERE ok
   AND ts > now() - interval '48 hours'
 GROUP BY 1
 ORDER BY p95_ms DESC;
```

Filter on `ok` deliberately. Failed samples also carry a `latency_ms` (`poller.ts:176`) and an
unreachable host sits there until the 10-second transport timeout expires
(`transport.ts:48`, `rcon.ts:32`), so leaving failures in moves the p95 by whole seconds and tells
you about reachability rather than about latency.

Note what this column measures: `Date.now() - started` where `started` is set at `poller.ts:159`,
before the client is constructed. It covers the host-policy check (a DNS lookup at most once per
60 s per host), the `/v1/status` call and the `/v1/players` call, in sequence. It is the cost of a
whole tick for one server, not of one HTTP request — so a p95 of 500 ms is roughly 250 ms per call.

If the p95 is higher, the next question is whether the game server is slow or the network is. The
brief for this phase suggests checking `gameThreadQueue.depth` on `/v1/health`. **That endpoint
does not appear anywhere in this repository** — no `ACTIONS` entry, no mention in
`docs/wardogs-api.md`'s route table, and greps for `v1/health` and `gameThreadQueue` across `src/`
return nothing. If the live build serves it, reach it by hand with `curl` against the listener, or
through the admin-only `raw` action (`actions.ts:547-579`), which permits any `/v1/` path and
audits the call. Do not expect the panel to surface it.

### The ground-truth check passes

All four checks in §6, on at least one server, across at least one match boundary.

### Persona names resolve

Spot-check the players table in the panel, or:

```sql
SELECT count(*) FILTER (WHERE persona <> '') AS with_persona,
       count(*)                              AS total
  FROM steam_profiles
 WHERE fetched_at > now() - interval '48 hours';
```

### Matches close with a winner at real rotation changes, and `peak_players` looks plausible

```sql
SELECT m.id, v.name, m.map, m.started_at, m.ended_at,
       m.ended_at - m.started_at AS duration,
       m.peak_players, m.winner, m.final_scores
  FROM matches m
  JOIN servers v ON v.id = m.server_id
 WHERE m.started_at > now() - interval '48 hours'
 ORDER BY m.started_at DESC;
```

Read it against the rotation you know the servers are running. Durations should cluster around
your match length; `peak_players` should never exceed `max_players` from the same period; `winner`
should be a faction name on decided matches.

`winner` being null is not automatically wrong. It is null on a draw, when nobody scored, and
deliberately after an outage: `closingScores` returns null for a `stale` boundary or when the
process has no previous scores (`match-track.ts:53-55`), so the match closes with no outcome rather
than handing every player a result belonging to the *next* match. Expect a null winner on the first
match after each restart. A run of consecutive nulls is a real finding.

```sql
-- how many matches closed without an outcome, and how many of those follow a gap
SELECT count(*) FILTER (WHERE winner IS NULL) AS no_winner,
       count(*)                               AS matches
  FROM matches
 WHERE ended_at > now() - interval '48 hours';
```

## Kill criteria

Stop and diagnose rather than pressing on.

### Ok rate below 95%, or errors clustering at a fixed interval

Regular spacing points at rate limiting or an unstable endpoint rather than at the network. Look at
what the failures actually say — the game's own message is stored verbatim, truncated to 300
characters (`poller.ts:171`):

```sql
SELECT server_id, error, count(*), min(ts), max(ts)
  FROM samples
 WHERE NOT ok AND ts > now() - interval '48 hours'
 GROUP BY 1, 2
 ORDER BY 3 DESC;
```

`Could not reach <host>:<port> (<code>).` is a transport failure (`transport.ts:58`, wrapped as a
502 at `rcon.ts:65`). Anything else is the game server's own error body (`rcon.ts:84-91`) — a 429
message here is the rate limit answering you directly.

**Drop `POLL_SECONDS` to 30 and retest before concluding anything else.** That takes the budget
from 6.4 to 4.4 requests per minute per server. If the ok rate recovers, the cause was volume; if
it does not, it was not, and you have ruled out the cheapest explanation for the cost of one
restart.

### Kills or deaths drifting from the scoreboard across a match boundary

**Stop.** Do not soak on, and do not carry on to Phase 3. This means the increment logic is
mismatched against this build, and every downstream leaderboard, career page and Discord board
inherits the error — silently, and in data that is already written.

The fix belongs in `src/lib/server/match-track.ts`, which is a set of pure functions covered by
`match-track.test.ts`. The three candidates:

| Symptom | Likely function |
| --- | --- |
| Totals double after a reconnect or an outage | `baselineAfterGap` (`match-track.ts:63-70`) and its use at `poller.ts:367`, `poller.ts:372` |
| The new match inherits the old match's totals | `matchBoundary` (`match-track.ts:85-100`) not firing — `RESTART_SLACK_S = 30` at `:73`, so a clock that goes backwards by less than 30 s is treated as jitter |
| Counters reset mid-match | `counterDelta` (`match-track.ts:16-20`) seeing a drop that was not a reset |

`CLAUDE.md` rule 1 applies: say which of the five load-bearing behaviours you are changing, and add
a test to `match-track.test.ts` that fails before the change and passes after.

### Sessions never closing for players who have plainly left

The constant to look up is in `src/lib/server/poller.ts:45-46`:

```ts
/** Close open sessions after this many consecutive failed polls. */
const OFFLINE_AFTER_FAILURES = 3;
```

It is consulted once, at `poller.ts:179`:

```ts
if (m.failures === OFFLINE_AFTER_FAILURES) {
```

Note the semantics before you reach for it:

- It is `===`, not `>=`. The mass close runs on the tick where the counter reaches exactly 3, and
  once only. `m.failures` resets to 0 on any successful tick (`poller.ts:194`).
- At `POLL_SECONDS=20` that is about 60 seconds of continuous failure before sessions close.
- `m.failures` lives in the per-process `memory` map (`poller.ts:70-87`). A restart or a leader
  failover resets it to 0, so the countdown starts again — a process that restarts every 40 seconds
  during an outage never reaches 3.
- Sessions close at `last_seen`, not at the current time (`poller.ts:182`), so a late close does
  not invent playtime. It leaves the row open, not wrong.

So a genuinely stuck session means one of: the poller is not running for that server (check
`POLL_SECONDS` and leadership), the polls are succeeding and the game server is still listing the
player in `/v1/players`, or the process keeps restarting. Find which before changing the constant.
Open sessions are visible directly:

```sql
SELECT server_id, steam_id, name, joined_at, last_seen,
       now() - last_seen AS stale_for
  FROM player_sessions
 WHERE left_at IS NULL
 ORDER BY last_seen ASC;
```

A `stale_for` much larger than `POLL_SECONDS` on a server whose recent samples are `ok` is the
signature of a ghost in the game server's own player list.

## What to watch in the logs

The poller is quiet by design. **A failing server logs nothing** — the error is caught inside
`pollServer` at `poller.ts:169` and written to `samples.error`. `[warcon] poll` only fires when
`pollAll` itself rejects, which in practice means a database failure, because `pollServer` handles
every game-side error itself. The `samples` table is the monitoring surface; the log is for the
things `samples` cannot record.

### Startup — expect these, in this order

| Line | Source |
| --- | --- |
| `[warcon] rewrote N double-encoded jsonb rows` (only when there were any) | `env.ts:140` |
| `[warcon] database ready (timescaledb on)` or `(timescaledb off)` | `env.ts:142` |
| `[warcon] analytics poller every 20s` | `poller.ts:144` |
| `[warcon] this instance is the analytics poller` | `poller.ts:118` |

The last two are separate for a reason: the first says the interval was configured, the second says
this process won `pg_try_advisory_lock` and is the one doing the work. With several replicas only
one prints the second line; the others serve HTTP and poll nothing.

### Startup — any of these means stop

| Line | Source | Meaning |
| --- | --- | --- |
| `[warcon] analytics poller disabled (POLL_SECONDS=0)` | `poller.ts:131` | No sampling at all. See §5 — an empty or non-numeric value does this. |
| `[warcon] ENCRYPTION_KEY is not set; servers cannot be added.` | `hooks.server.ts:35` | Boots fine, health returns 200, Save fails later. |
| `[warcon] BETTER_AUTH_SECRET is not set; the panel will refuse to serve pages.` | `hooks.server.ts:32` | Every page 503s. |

### Running — what each line tells you

| Line | Source | Read it as |
| --- | --- | --- |
| `[warcon] leader lock <err>` | `poller.ts:121` | The reserved connection failed. `leaderConn` is dropped and retried next tick; no sampling until it succeeds. |
| `[warcon] poll <err>` | `poller.ts:138` | Not a game error — `pollServer` swallows those. This is the database, or something unhandled. |
| `[warcon] prune <err>` | `poller.ts:140` | Retention delete failed; runs roughly hourly (`poller.ts:139`). Tables grow until it succeeds. |
| `[warcon] list expiry <err>` | `poller.ts:137` | Timed list-entry expiry failed. |
| `[warcon] ban list snapshot <message>` | `poller.ts:222` (warn) | The 5-minute `/v1/bans` + `/v1/reserved-slots` read failed. The tick continues on the stored snapshot. |
| `[warcon] list sync <message>` | `poller.ts:233` (warn) | Pushing the org's lists failed. Never fatal to the tick. |
| `[warcon] status boards <err>` | `poller.ts:94`, `status-board.ts:303` | Discord delivery. Runs off the sampling path, so it never delays a tick. |
| `[warcon] status boards offline <err>` | `status-board.ts:319` | The offline card could not be posted after three failed polls. |
| `[warcon] steam lookup <message>` | `steam.ts:177` (warn) | Steam refused or was unreachable; cached rows were used. `Steam refused the configured API key.` means `STEAM_API_KEY` is wrong. |
| `[warcon] triggers <err>` | `triggers.ts:238` | The trigger rows could not be read. |
| `[warcon] trigger <name> <message>` | `triggers.ts:246` | One named trigger threw; the others still ran. |
| `unhandled <stack>` — no `[warcon]` prefix | `http.ts:61` | An error `publicMessage` did not recognise. Always worth reading; it is the one line that is not routine. |

During the soak, grep for anything that is not in the two "expect these" tables:

```bash
docker compose logs -f warcon 2>&1 | grep -v 'analytics poller every' | grep -Ei '\[warcon\]|unhandled'
```

A quiet log plus an ok rate above 99% is the shape of a healthy Phase 2. A quiet log on its own
proves nothing — check `samples`.

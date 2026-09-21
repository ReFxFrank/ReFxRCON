# ReFxRCON

A WARDOGS RCON + analytics panel for ReFx. **This is a fork of
[warcon](https://github.com/Esprit-De-Corps-Gaming/warcon)**, merged at upstream commit
`20477c4` (v0.2.0, MIT, 2026-09-16) with history preserved — `git blame` distinguishes
inherited code from ReFx changes.

## Read this first

**We own this fork outright.** Do not expect upstream fixes, do not plan around upstream
merges, and do not assume an upstream bug will be someone else's to fix.

The reason is not the one you may have been told. The build brief states that upstream "has
a single squashed commit dated 2026-09-16" with "no maintenance track record to read". That
is an artefact of a `--depth 1` clone. Upstream actually has **34 commits spanning
2026-09-08 to 2026-09-16** by two authors, and the record is worth reading — several
commits are explicitly security work:

```
40e3ce9  Use same-origin referrer policy so plain form posts keep their Origin header
38f676c  Close the Better Auth HTTP surface, keep secrets out of the audit log, fix startup config
20477c4  Fix the audit findings in match tracking and the public surface
```

`git log upstream/main` reads normally here because this fork was unshallowed on purpose.
When you need to know why a line exists, that history will usually tell you.

What _is_ true is that the project is **nine days old**, written by a very small team, and
has no release cadence to plan around. That is the real argument for owning the fork — youth
and bus factor, not opacity. Judge upstream on the code and its tests, which are good, and
on the fact that nobody has yet had to maintain it.

## Stack

|              |                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------ |
| Runtime      | Bun ≥ 1.2 (`bun`, not `node`)                                                              |
| Framework    | SvelteKit 2, Svelte 5 **runes** (`$state`, `$derived`, `$props`)                           |
| Styling      | Tailwind **v4** — tokens declared in `src/app.css` via `@theme`, utilities via `@utility`  |
| Data         | Drizzle ORM + Postgres; TimescaleDB optional (`samples` becomes a hypertable when present) |
| Deploy       | `adapter-node`, Docker Compose, Caddy in front                                             |
| Runtime deps | `better-auth` and `drizzle-orm` only — keep it that way                                    |

## Commands

**Bun 1.4+ is required**, not the `>=1.2` that `engines` used to claim. `bun.lock` is
`lockfileVersion: 2`, which bun 1.3.x cannot parse: it warns `UnknownLockfileVersion`,
**silently ignores the lockfile**, and rewrites it as v1 with ~60 transitive dependencies
floated to newer patch versions. CI runs `bun install --frozen-lockfile`, so that rewrite
is both a broken build and an unreviewed dependency bump. If `git status` shows `bun.lock`
modified after an install you did not intend as an upgrade, your bun is too old — upgrade
it and `git checkout -- bun.lock`.

```bash
bun install --frozen-lockfile   # what CI runs; use this, not bare `bun install`
bun run dev      # http://localhost:5173  — ORIGIN must match exactly
bun run build    # adapter-node production build
bun run start    # bun ./build/index.js   — serves :3000
bun run lint     # prettier --check .
bun run check    # svelte-check
bun test         # bun test
bash scripts/smoke.sh   # end-to-end, needs a FRESH database; WARCON_URL=http://localhost:3000
```

**The full gate, run before every commit:**

```bash
bun run lint && bun run check && bun test && bun run build
```

Migrations in `./drizzle` run automatically at startup. Never hand-edit an applied
migration; add a new numbered one.

### Local development without Docker

Docker is not always available. A plain Postgres 16 cluster works — TimescaleDB is optional
and the schema degrades gracefully (`0000_init.sql` skips `create_hypertable` when the
extension is absent, and startup logs `timescaledb off`).

```bash
initdb -D ~/pgdata -A trust -U postgres
pg_ctl -D ~/pgdata -o '-p 5432 -c listen_addresses=127.0.0.1' -l /tmp/pg.log start
psql -U postgres -c "CREATE ROLE warcon LOGIN PASSWORD 'warcon' SUPERUSER" \
                 -c "CREATE DATABASE warcon OWNER warcon"
```

Then set `DATABASE_URL=postgres://warcon:warcon@127.0.0.1:5432/warcon` in `.env`.

`ALLOW_DEMO_SERVER=true` accepts host `demo` with password `demo` and serves the mock
WARDOGS server in `src/lib/server/mockgame.ts`. The whole pipeline — poller, sessions,
matches, charts — runs against it with no real server and no credentials. **Do UI work
against the demo server, never against live sampling.**

## Rules

### 1. `poller.ts` and `match-track.ts` are not to be refactored casually

`src/lib/server/poller.ts` and `src/lib/server/match-track.ts` solve problems that are not
obvious until you hit them in production. Each of these is load-bearing:

- **Counter resets at match boundaries.** Kills and deaths are stored as _increments over
  the previous reading_, not absolutes, so a match rollover does not zero everyone's totals.
- **Baselines after a gap.** A player with no open session may have had one that an outage
  closed mid-match; the last raw reading is recovered as the baseline, or their counters
  get double-counted.
- **Outage handling.** After `OFFLINE_AFTER_FAILURES` consecutive failed polls, open
  sessions close at their `lastSeen` rather than accruing phantom playtime.
- **First-tick suppression.** Joins seen on a process's first successful tick are
  reconnects, not arrivals, and must not fire join events.
- **Leader election.** `pg_try_advisory_lock` on a reserved connection keeps extra replicas
  idle instead of double-sampling.

If you touch either file: say which of the five behaviours above you are changing, and add
a test to `match-track.test.ts` that fails before your change and passes after. A
"simplification" that drops one of these is a regression that only shows up days later, in
data that is already wrong.

### 2. Never rename a Tailwind token

Tailwind v4 generates utility classes from `@theme` token _names_: `--color-ink-900`
produces `bg-ink-900`. Changing a token's **value** is free and is how reskins are done.
**Renaming** one silently breaks every usage at once (there are hundreds).

Keep the `ink` / `mist` / `accent` families. Repoint their values.

### 3. No scoped `<style>` blocks, no raw Tailwind palette classes

Every component styles itself through semantic tokens and `@utility` classes. That
discipline is why a reskin is a one-file job. A scoped `<style>` block or a raw palette
class (`bg-slate-800`, `text-blue-500`) makes the next reskin a rewrite.

Colour belongs in `src/app.css`. The only legitimate exception is an SVG **presentation
attribute**, which cannot take a Tailwind class — use `var(--color-*)` there, never a
hardcoded hex.

### 4. These look like branding. They are protocol. Do not rebrand them.

| Identifier                                | Where                                          | Why                                                                                                          |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `cookiePrefix: 'warcon'`                  | `src/lib/server/auth.ts`                       | Renaming signs every existing user out                                                                       |
| `CLIENT_IP_HEADER = 'x-warcon-client-ip'` | `src/lib/server/http.ts`                       | Internal header contract                                                                                     |
| `x-requested-with: warcon`                | `src/lib/api.ts` **and** `src/hooks.server.ts` | CSRF handshake — asserted in **two** places; change one without the other and every form post starts failing |

`APP_NAME` is the rebranding lever for user-visible chrome. Use it.

### 5. `FACTION_FALLBACK` is game semantics, not chrome

`src/lib/format.ts` — leave it alone during reskins. The server's own `colorHex` overrides
it anyway, and `faction` is a server-defined name that must be matched to a `factionScores`
row **by `colorHex`**, which is the stable key.

### 6. Secrets

- `ENCRYPTION_KEY` (base64 of exactly 32 bytes) encrypts every stored RCON password with
  AES-256-GCM. **A database backup without this key is worthless.** Back it up out of band.
- `BETTER_AUTH_SECRET` signs sessions. The `.env.example` placeholders are actively refused
  at startup — generate both with `openssl rand -base64 32`.
- Never log a decrypted RCON password, and never send one to the browser. A migration
  scrubs secrets from audit detail before insert; keep it that way.

## Security posture — the thing to keep in mind

The WARDOGS RCON API has one structural weakness and everything follows from it: **a single
bearer token authorises every endpoint, and the listener speaks plain HTTP with no TLS.**
That token is the RCON password. It authorises reading the scoreboard, kicking, banning,
ending the match, and replacing the entire server config. There is no read-only key.

At `POLL_SECONDS=20` that is ~4,300 cleartext transmissions of a full-access credential per
server per day. Encryption at rest does nothing for a credential in flight. See
`docs/refx/security.md`.

The **reason to run a panel at all** is the audit trail: the game's own log records a peer
address and a session ID, the panel records a _person_. Every command is attributed to the
admin account that issued it. That is the only way to put moderators on a server without
handing each of them a credential that can replace the whole config. Do not weaken audit
attribution for convenience.

## Decision register

Defaults apply if a decision is never made, so the build never stalls on one.

| #   | Decision                                                                        | Setting                                                        | Status                         |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------ |
| D1  | RCON password crossing the internet in cleartext, or a tunnel from xREALM first | Proceed cleartext; rotate the password immediately after setup | **Open — decide deliberately** |
| D2  | VPS provider and specs                                                          | 2 vCPU / 4 GB RAM / 60 GB NVMe                                 | Open                           |
| D3  | Panel hostname                                                                  | `stats.refx.gg`                                                | Open                           |
| D4  | Public player-facing stats pages                                                | Off at launch; enable per server once the data is trusted      | Open                           |
| D5  | Steam Web API key                                                               | Yes — without it there are no persona names, only SteamID64s   | Open                           |
| D6  | Discord OAuth sign-in for admins                                                | Password accounts at launch; add Discord in Phase 4            | Open                           |
| D7  | `EMAIL_SUFFIX` domain                                                           | **`@refx.gg`** — settled, applied in `auth.ts`                 | **Closed**                     |
| D8  | Sample retention window                                                         | 90 days via the TimescaleDB retention policy                   | Open                           |
| D9  | Poll interval per server                                                        | 20 s (shipped default; floor 5 s)                              | Open                           |
| D10 | WARDOGS servers at launch                                                       | Whatever is live; per-org cap is 10                            | Open                           |

**D7 is closed and was irreversible.** Accounts key off `EMAIL_SUFFIX`; changing it after
the first account exists is a data migration, not a rename. It is `@refx.gg`. These
addresses are keys, not mailboxes — never configure mail delivery for them.

**D1 is the one worth deciding deliberately** rather than by default.

## Layout

```
src/lib/server/    poller.ts, match-track.ts, analytics.ts, rcon.ts, auth.ts, crypto.ts,
                   hostpolicy.ts, mockgame.ts, db/{index,schema}.ts
src/lib/components/  51 Svelte components, all token-styled
src/routes/(app)/  authenticated panel
src/routes/api/    JSON routes
drizzle/           numbered SQL migrations, applied at startup
docs/refx/         ReFx runbooks (phases 0/2/4), security posture
scripts/           smoke.sh (end-to-end), branding.ts (asset generator)
```

## Tenancy

Three layers: global role → `org_members` → `server_grants` (viewer / operator / admin).
Per-server RCON passwords are AES-256-GCM encrypted under `ENCRYPTION_KEY`. Since the
WARDOGS API has no read-only token, that encryption plus per-server grants is the **only**
way to put admins on the panel without handing out full server control. Reserve `admin` for
people who should be able to replace the server config; moderators get `operator`.

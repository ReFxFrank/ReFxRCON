# Security posture

**Status of this document.** Everything below about the codebase was read out of this repository
and is exact — file paths, address ranges, rate limits and error strings were all verified
against the source. Nothing about the xREALM deployment has been verified, because this was
written without access to a VPS or a live RCON endpoint. Where a claim is about how xREALM
behaves, it comes from the build brief and the community reference, not from observation.

## The structural weakness, and everything that follows from it

The WARDOGS RCON API has one: **a single bearer token authorises every endpoint, and the
listener speaks plain HTTP with no TLS.**

That token is the RCON password. It authorises reading the scoreboard, kicking, banning, ending
the match and replacing the entire server config. There is no read-only key.

So at `POLL_SECONDS=20`, this panel sends a full-access credential in cleartext roughly **4,300
times a day per server**, across the public internet between the VPS and xREALM. Anyone
positioned to read that traffic — a compromised router, a hostile network operator, anyone on a
shared segment at either end — has full control of the game server, permanently, and nothing in
this panel can detect it.

This is decision **D1**. **It is decided: accept and rotate.**

That is a legitimate choice — it is the option the brief lists third, and it is the one most
people take because the alternatives need xREALM's cooperation. But it is only legitimate if the
rotation actually happens. An accepted risk with no rotation schedule is an unexamined risk with
extra paperwork. See "Rotating an RCON password" below, and put the schedule somewhere that is
not this file.

If xREALM ever offers a tunnel or a TLS proxy, take it — this decision is cheap to revisit, and
the options below stay here for that day.

### Options, best first

1. **A tunnel.** Ask xREALM whether they offer a private network, WireGuard, or an SSH tunnel to
   the game host. This removes the problem rather than managing it. See "the tunnel case" below
   — it interacts with the SSRF guard and needs one deliberate step.

2. **A TLS-terminating proxy** in front of the RCON listener, if they will run one. The
   community reference recommends exactly this. The panel already supports `scheme: https` per
   server; `GAME_TLS_INSECURE=true` exists for a self-signed certificate, but note it applies to
   **every** https game server, not one of them, so prefer a real certificate.

3. **Accept and mitigate.** Rotate the RCON password on a schedule, keep the panel's admin
   surface tight, and understand what you are accepting. Encryption at rest does nothing for a
   credential in flight. If you take this option, write down the rotation interval somewhere
   that is not this file, and rotate immediately after initial setup — the password will have
   been typed into a browser, a terminal and at least one chat message by then.

**Raising `POLL_SECONDS` is not a mitigation.** It reduces exposures per day; one interception is
enough.

## What the codebase already gets right

Do not undo any of these.

| | Where |
| --- | --- |
| RCON passwords AES-256-GCM encrypted at rest under `ENCRYPTION_KEY`, never sent to the browser | `src/lib/server/crypto.ts`, blob format `v1.<b64 iv>.<b64 ciphertext‖tag>` |
| A dedicated migration that scrubs secrets from audit detail before insert | `drizzle/0004_audit_scrub_secrets.sql` |
| An SSRF guard that blocks loopback, RFC1918, CGNAT and link-local targets by default, re-checked before **every** outbound request so a hostname that later re-points internally is still caught | `src/lib/server/hostpolicy.ts` |
| CSRF origin checks driven by `ORIGIN`, plus an `X-Requested-With: warcon` handshake on every non-GET `/api/*` | `src/hooks.server.ts` |
| The Better Auth HTTP surface closed except the OAuth callback and error pages | `src/hooks.server.ts` |
| Login throttling, and per-address limits on public JSON | `src/lib/server/ratelimit.ts`, `src/lib/server/public.ts` |
| A non-root container with a healthcheck | `Dockerfile` (`USER bun`) |
| `referrer-policy: same-origin` rather than `no-referrer` — under `no-referrer` browsers send `Origin: null` on form posts and SvelteKit rejects them as cross-site | `src/hooks.server.ts` |

### What the SSRF guard actually blocks

`classifyV4` in `src/lib/server/hostpolicy.ts`, in evaluation order:

| Range | Classified |
| --- | --- |
| `169.254.0.0/16` | link-local — refused for **everyone**, including the site owner |
| `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8` | private |
| `100.64.0.0/10` | private (carrier-grade NAT — **this is Tailscale**) |
| `172.16.0.0/12` | private |
| `192.168.0.0/16` | private |
| `192.0.0.0/24`, `192.0.2.0/24` | private (IETF protocol assignments, TEST-NET-1) |
| `198.18.0.0/15` | private (benchmarking) |
| `198.51.100.0/24` | private (TEST-NET-2) |

Link-local is refused unconditionally. Everything else marked private is refused **unless** the
server row carries `allow_private = true`.

### The tunnel case

If you take option 1, the RCON target becomes a private address and the host policy will refuse
it. There is no config flag and no environment variable for this. The allowance comes from the
role of whoever saves the target, and is persisted on the row:

1. Sign in as the **site owner** — the account created by first-run `/setup`, or anyone it later
   promoted on the Users page. An organisation owner cannot do this and will get:
   *"Only publicly reachable game servers can be added here. If the game server shares a machine
   or network with this panel, ask the site owner to add it."*
2. Add or edit the server so that host, port or scheme is written. That sets `allow_private` on
   the row.
3. Afterwards the poller and any operator can use it: the re-check reads `allow_private` from
   the row, not from the current actor.

If the row already exists with `allow_private = false`, a site owner saving it without changing
the target flips the flag anyway — saving it is taken as vouching for it.

For `host.docker.internal`, also uncomment the `extra_hosts` line in the compose file. It usually
resolves to `172.17.0.1`, which is private, so the site-owner step is still required.

## Rotating an RCON password

D1 is accepted on the condition that this happens. The panel makes it a two-minute job, and
nothing is lost while it runs.

**Rotate immediately after initial setup.** By the time a server is live the password has been
typed into a browser, a terminal, and — in practice — at least one chat message. The first
rotation is the one that retires all of those.

**Then on a schedule.** Monthly is a reasonable default for a community server. Quarterly is
defensible. "When we remember" is not a schedule.

1. Change the password on the game server, through xREALM's own tooling.
2. In the panel: **Servers → the server → edit → Password**, and save. It is encrypted with
   AES-256-GCM under `ENCRYPTION_KEY` before it touches the database, and never sent back to a
   browser.
3. The poller picks it up on its next tick — no restart, no downtime. A tick that lands in the
   gap between steps 1 and 2 fails, writes one `ok = false` sample, and recovers on the next
   one. That is a single point on the population chart, not an outage.
4. Check the audit log: the edit is attributed to whoever made it.

**Also rotate, off-schedule, whenever:**

- someone with `admin` on that server leaves the team,
- the password appears in a chat log, a screenshot, a support ticket or a bug report,
- you change hosting, or xREALM migrates the server,
- anything about the VPS looks wrong.

**What rotation does not fix.** Anyone who captured the old password had full control for as long
as it was valid, and could have used it to add their own ban entries, change the config, or read
the ban list. Rotation stops future use; it does not undo past use. If you suspect interception
rather than mere exposure, read the audit log **on the game server** as well as in the panel — the
panel only records commands issued through the panel.

## The public surface, now that D4 is on

D4 is decided: status, leaderboards and career pages are public. That puts unauthenticated,
database-backed routes on the internet, so here is what is actually in front of them, measured
against this codebase with 129,614 samples and 2,163 matches.

**Load is not the problem.** Served costs, at 10 concurrent requests:

| Route | p50 | p95 |
| --- | --- | --- |
| `/api/public/servers/{id}/status` | 5 ms | 132 ms |
| `/api/public/servers/{id}/leaderboard` | 11 ms | 29 ms |
| `/public/{id}/stats` (the page) | 8 ms | 49 ms |

**The limiter works.** A 150-request burst from one address returned 115 × 200 and 35 × 429,
which is the 120-per-60-seconds budget doing its job. A rejected request costs about 2 ms,
because the limiter sits in front of the database.

**The budget's shape is the problem.** Those 120 requests per 60 seconds are counted **per client
address**, and they are shared between the public JSON routes *and* the public page loads — a
burst against the leaderboard leaves nothing for the stats page, which is exactly what the
measurement showed. The public page polls every **10 seconds**:

| Viewers sharing one public IP | Requests/min | Result |
| --- | --- | --- |
| 10 | 60 | fine |
| 20 | 120 | at the ceiling |
| 25 | 150 | **every one of them gets 429s** |
| 40 | 240 | **every one of them gets 429s** |

Behind CGNAT, a mobile carrier, a university network, or one town's ISP, twenty-one concurrent
viewers is an ordinary Saturday — and the failure is indiscriminate, hitting everyone on that
address at once.

**Two fixes, either is enough:**

1. **A cache in front.** The status route already sends `cache-control: public, max-age=5` and has
   a matching 5-second in-process cache, so a CDN that honours it collapses any number of viewers
   into one origin request per 5 seconds — and cached responses never reach the limiter at all.
   Cloudflare's free tier does this. Respect the 5 seconds and nothing longer; the other public
   routes are `no-store` and must not be cached.
2. **Raise the limit.** `publicRate` in `src/lib/server/public.ts` is `120, 60_000`. Given the
   measured per-request costs, several times that is affordable. Change it deliberately, with the
   numbers above in view, rather than reactively when people complain.

**And the two standing caveats.** The limiter is in-process: it **resets on every deploy**, and a
second replica **doubles** the effective limit. `docker-compose.prod.yml` runs one app container
for that reason — scaling it is a security decision, not an ops one.

## Rate limiting is per process

`src/lib/server/ratelimit.ts` is an in-memory sliding window. Its own header comment says it:
*"Per process: with several replicas the effective limit is that many times higher."* It also
resets on every restart and deploy.

Public JSON is 120 requests per 60 seconds per address, and **page loads share that budget with
the JSON routes** — an HTML view and a poll both spend from the same 120.

This matters for D4. If public player-facing stats pages are enabled, one process is the only
thing enforcing the limit, and a deploy resets it. Run one replica, or move rate limiting to the
proxy.

## The audit trail is the point

This is the real argument for running a panel at all, and it is worth stating plainly because it
is what justifies accepting D1.

The game's own log records a peer address and a session ID. The panel records **a person**. Every
command is attributed to the admin account that issued it, with the client IP alongside it.

That is the only way to put moderators on a server without handing each of them a credential that
can replace the whole config. Ten moderators sharing an RCON password is ten copies of a
full-access token in ten chat clients, and no way to answer "who banned this player" afterwards.

So: **do not weaken audit attribution for convenience.** In particular, get `ADDRESS_HEADER` and
`XFF_DEPTH` right at deploy time and then verify the audit log shows real client addresses. When
they are wrong the failure is silent — the address is recorded as empty, nothing returns an
error, and every affected request also collapses into a single shared rate-limit bucket. A
blank IP column is not cosmetic; it is the attribution quietly not working.

## Operational rules

- **`ENCRYPTION_KEY` is backed up out of band, and separately from the database dumps.**
  `docs/refx/backup.sh` writes it beside each dump; move both off the machine, and do not put
  them in the same place as each other if you can avoid it.
- **Rotate the RCON passwords after initial setup**, and on a schedule if you took option 3.
- **`ALLOW_DEMO_SERVER=false` in production.** It defaults **on**, and a demo-host server
  bypasses the host policy entirely.
- **`ALLOW_ORG_SIGNUP=false` in production**, unless you intend strangers to create tenants.
- **Remove `SETUP_TOKEN`** once owner setup is done.
- **Reserve the `admin` server grant** for people who should be able to replace the server
  config. Moderators get `operator`.
- **Never log a decrypted RCON password**, and never send one to the browser.

## Reporting

The upstream project ships a `SECURITY.md`. This fork is owned outright and upstream is nine days
old with no maintenance track record, so do not assume a report there reaches anyone. Treat
anything found here as ours to fix.

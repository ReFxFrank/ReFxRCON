# Phase 0: Provision

**Goal: a VPS that can reach the xREALM RCON endpoint, proven before any code is written.**

Everything downstream assumes the panel's own process can open a plain HTTP connection to the
game host's RCON port. That assumption is cheap to test now and expensive to discover later, so
this phase ends with a single gate: a `curl` from the VPS that comes back with JSON.

> **What has and has not been verified.** This runbook was written without a VPS, without a live
> xREALM RCON endpoint and without a deployment target. No command below has been executed end to
> end. What _was_ verified: every line number, constant, default, error string and address range
> quoted here was read out of this repository and is exact — the retention constants in
> `src/lib/server/poller.ts`, the build's memory cost measured on a 4 vCPU / 16 GB machine, the
> Dockerfile and Compose contents, the 10-second transport timeout, and the `/v1/capabilities`
> shape the panel consumes. What was not: the provisioning itself, the network path from any VPS
> to xREALM, the RCON responses, and the deploy. Treat the numbers as reliable and the procedure
> as untested.

---

## 1. Sizing

| Resource | Figure | Driven by |
| --- | --- | --- |
| vCPU | 2 | Build parallelism; runtime is close to idle |
| RAM | 4 GB | **The Docker build, not runtime** |
| Disk | 60 GB NVMe | Images, build cache, Postgres WAL, a local `pg_dump` copy |

This is D2 in the decision register (`CLAUDE.md:185`), still open. The defaults above are what the
build brief proposes.

### Why 4 GB and not 2 GB

The shipped `Dockerfile` builds from source. `Dockerfile:2-7` is a full build stage — it copies the
tree in and runs `bun run build`, and `Dockerfile:5` installs **all** devDependencies (vite 8,
rolldown, the Tailwind and svelte-check toolchains) to do it. That is where the memory goes, and
none of it is present at runtime; the second stage (`Dockerfile:9-19`) installs with
`--production` and ships 13 MB of output.

Measured on a 4 vCPU / 16 GB machine: `bun run build` exited 0 with a peak of roughly **1650 MB
RSS** summed across the `bun`, `vite` and `rollup` process tree. On a 4 GB box that fits with room
for Postgres running alongside. On a 2 GB box with no swap it does not, and the failure mode is a
bare **exit 137** from the OOM killer partway through `vite build`, with nothing in the output that
names memory as the cause.

**If you are committed to a smaller box**, do not build on it. Build the image elsewhere, push it
to a registry, and switch the app service from building to pulling — `docker-compose.yml:6` is
`build: .` and `docker-compose.yml:7` is the commented-out `# image: ghcr.io/<you>/warcon:latest`
line, already in place for exactly this:

```bash
# on a build machine
docker build -t ghcr.io/<you>/refxrcon:<tag> .
docker push ghcr.io/<you>/refxrcon:<tag>

# on the VPS: comment out `build: .`, uncomment and pin the `image:` line
docker compose pull && docker compose up -d
```

Adding swap before `docker compose build` also works and is the smaller change, but it trades an
OOM kill for a build that may take several times longer.

---

## 2. Storage maths

Row counts follow directly from D9 (`POLL_SECONDS=20`, `CLAUDE.md:192`) and four servers. The
poller writes **one `samples` row per server per tick** (`src/lib/server/poller.ts:197-209`, and on
a failed poll `:172-178`), so 86,400 / 20 = 4,320 rows per server per day.

| Table | Rows/day (4 servers) | Retention | Estimated size |
| --- | --- | --- | --- |
| `samples` | 17,280 | 90 days | ~700 MB with indexes |
| `player_sessions` | ~800 | 365 days | ~60 MB |
| `player_match_stats` | ~7,700 | 365 days | ~450 MB |

Under 2 GB in year one. The 60 GB disk is not sized for the data; it is sized for Docker images,
the build cache, Postgres WAL and somewhere to put a dump.

The row counts and the retention windows are exact. The byte figures are the build brief's
estimates and have not been measured against real data.

### The retention constants, as they actually are in the code

`src/lib/server/poller.ts:43-44`:

```
43 const SAMPLE_RETENTION_DAYS = 90;
44 const SESSION_RETENTION_DAYS = 365;
```

Two things about how those are applied are worth knowing before you size anything:

- **`samples` is pruned by one of two different mechanisms.** With TimescaleDB installed,
  `drizzle/0000_init.sql:171-179` makes `samples` a hypertable and installs
  `add_retention_policy('samples', INTERVAL '90 days')`, which the database enforces on its own.
  On plain Postgres the extension is absent, that block is skipped, and the poller does the delete
  itself (`poller.ts:554-557`) — but only when `!env.timescale`. The shipped Compose file uses
  `timescale/timescaledb:2.30.0-pg18` (`docker-compose.yml:30`), so the in-database policy is the
  one that will run.
- **`SESSION_RETENTION_DAYS` covers three tables, not one.** `prune()` deletes from
  `player_sessions` (`poller.ts:558`), `player_match_stats` (`:561`) and `matches` (`:562`) at the
  same 365-day cutoff.

**The failure mode to know now, because it changes the disk question entirely:** `prune()` runs
only from the poller's leader tick (`poller.ts:139`, roughly hourly). If `POLL_SECONDS` is 0, empty
or non-numeric the poller never starts and `prune()` **never runs** — on plain Postgres every one
of those four tables then grows without bound. The only signal is one log line,
`[warcon] analytics poller disabled (POLL_SECONDS=0)`. This does not bite in Phase 0, but it is why
the poller's log line is on the Phase 1 acceptance list rather than treated as cosmetic.

D8 (retention window) is still open. If it is later lowered, note that the panel's 90-day analytics
range stops working below about 32 days of samples.

---

## 3. Region

**Favour proximity to the game servers, not to the operator.** The two workloads have opposite
requirements:

- The panel is interactive over HTTPS and a human is waiting on it. It tolerates distance.
- The poller opens **two sequential RCON requests per server per tick** — `/v1/status` then
  `/v1/players` (`poller.ts:167-168`) — every `POLL_SECONDS`. Round-trip time is paid twice, on
  every tick, forever.

You do not have to guess whether the choice was right. Every poll records its own duration:
`samples.latency_ms` (`src/lib/server/db/schema.ts:300`), written on success at `poller.ts:209` and
on failure at `poller.ts:176`. A bad region shows up in the first hour of real sampling.

Read that column knowing what it measures. The clock starts at `poller.ts:159`, before the client
is constructed and the stored RCON password is decrypted, and stops after **both** requests have
returned. It is the cost of a whole poll, not one round trip.

The hard ceiling is the transport timeout: `src/lib/server/transport.ts:47` is
`AbortSignal.timeout(init.timeoutMs ?? 10000)`. A request that has not answered in 10 seconds is
abandoned and the tick is recorded as a failed sample. Three consecutive failures
(`OFFLINE_AFTER_FAILURES`, `poller.ts:46`) close every open player session on that server, so
sustained latency does not merely look untidy — it corrupts session data.

---

## 4. Tasks

### 4.1 Provision the host

Any provider. Record the **static public IPv4 address** before doing anything else: xREALM will
most likely have to allowlist it on their firewall, and this address is what they allowlist. If
you rebuild the VPS later and the address changes, the allowlist breaks silently and every poll
starts failing.

### 4.2 Install Docker Engine and the Compose plugin

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version    # the plugin, not the legacy `docker-compose` binary
```

Both commands must succeed. `docker compose` (with a space) is what the Phase 1 files assume.

### 4.3 Point the hostname at it

D3 defaults to `stats.refx.gg` (`CLAUDE.md:186`). Create an **A record** for it pointing at the
VPS address, and confirm it resolves before requesting a certificate:

```bash
dig +short stats.refx.gg
```

Do this now rather than during the deploy. Caddy obtains the certificate itself on first start, and
an ACME challenge against a hostname that does not yet resolve fails in a way that looks like a
Caddy problem.

Whatever hostname you settle on becomes `ORIGIN` in Phase 1, and it must be written exactly:
`parseOrigin()` (`src/lib/server/env.ts:92-105`) requires `new URL(raw).origin === raw`, so a
trailing slash, an explicit `:443`, a path or an uppercase host all throw at startup and the
container will not serve.

### 4.4 Firewall

| Port | Direction | Open to | Why |
| --- | --- | --- | --- |
| 22 (or your SSH port) | inbound | your addresses only | Administration |
| 80 | inbound | anywhere | ACME HTTP challenge, and the redirect to HTTPS |
| 443 | inbound | anywhere | The panel |
| 3000 | inbound | **nothing** | See below |
| 7776 outbound to the game hosts | outbound | — | The RCON path this phase exists to prove |

Port 80 stays open even though everything redirects to HTTPS: Caddy needs it to answer the ACME
challenge at renewal time, not only at first issue.

**Do not publish port 3000.** The repository's `docker-compose.yml:12-13` maps `'3000:3000'` on
every interface, which is right for a laptop and wrong for a VPS. Two separate things break if
that port is reachable from outside:

- Once `ADDRESS_HEADER` is set in Phase 1, the app trusts a request header for the client address.
  Anyone who can reach port 3000 directly can then forge it, which defeats both the audit trail and
  the per-IP login lockout. `README.md:151-153` states this directly.
- A page served over plain HTTP has an HTTP origin, and the app's trusted-origin list is exactly
  `[ORIGIN]` (`src/lib/server/auth.ts:203`). Every form post on such a page is rejected as
  cross-site.

`docs/refx/docker-compose.prod.yml` removes the published port for this reason; Phase 1 uses it.

---

## 5. The gate

This is the whole point of the phase. Run these **from the VPS**, not from a laptop — the question
is whether _this host_ can reach xREALM, and a laptop on a different network answers a different
question.

The RCON API is plain HTTP/1.1 JSON on the port from
`[/Script/WDRCON.WDRCONSettings] Port`, default **7776**, with the RCON password sent as a bearer
token on every request (`docs/wardogs-api.md:11-12`).

### 5.1 Does it answer at all

```bash
curl -sS -H "Authorization: Bearer <rcon-password>" \
  http://<xrealm-host>:7776/v1/status
```

A JSON body with `serverName`, `map`, `players` and `factionScores` means the gate is passed
(`docs/wardogs-api.md:26` documents the shape). Anything else — a timeout, a connection refused, a
401 — is a Phase 0 failure, not something to work around later.

### 5.2 Capabilities, and keep the output

```bash
curl -sS -H "Authorization: Bearer <rcon-password>" \
  http://<xrealm-host>:7776/v1/capabilities | tee capabilities.json
```

**Keep the `routes` array verbatim. Phase 2 branches on it.** The response shape is
`{ routes: ["GET /v1/status", ...], config: { writable } }` (`docs/wardogs-api.md:25`), and
`src/lib/server/actions.ts:131-151` is the code that consumes it. It normalises each route —
`{steamId}` and `:param` placeholders both collapse to `*` (`actions.ts:136-141`) — and then sets
two feature flags:

| Flag | Condition | Source |
| --- | --- | --- |
| `changeTeam` | `routes` contains `PATCH /v1/players/*` | `actions.ts:145` |
| `configDocument` | `routes` contains `PUT /v1/config` **and** `config.writable` is truthy | `actions.ts:146` |

Record the raw array rather than your reading of it. The normalisation means a route you would
write off as a near-miss may well match, and a route you would assume present may not be there at
all — `src/lib/server/servers.ts:252-256` wraps the capabilities call in a `try`/`catch` precisely
because "older plugin builds lack it".

### 5.3 Rate limit

Record `limits.maxRequestsPerMinutePerIp` from the capabilities response if xREALM's build returns
it.

Be clear about what this is for: **nothing in this codebase reads that field.** It is not consumed
by `actions.ts`, and the panel has no client-side throttle against the game server. It is a
planning input for you, because the panel's request rate against a given game host is fixed and
easy to compute:

- 2 requests per server per tick (`poller.ts:167-168`), so at `POLL_SECONDS=20` that is **6
  requests per minute per server**.
- Plus a ban-list and reserved-slot re-read every 5 minutes (`LISTS_TTL_MS`, `poller.ts:50`).
- Plus whatever operators do by hand in the panel.

All of it arrives from **one source address** — the VPS. If several xREALM servers sit behind the
same public address, multiply. If the recorded limit is lower than that total, `POLL_SECONDS` has
to rise, and that is a decision to make now rather than after the poller starts getting 429s.

### 5.4 Measure the latency you will be living with

```bash
for i in $(seq 1 20); do
  curl -sS -o /dev/null -w '%{time_total}\n' \
    -H "Authorization: Bearer <rcon-password>" \
    http://<xrealm-host>:7776/v1/status
done | sort -n | awk '{a[NR]=$1} END {print "median", a[int(NR/2)], "max", a[NR]}'
```

Record the median. Double it for a rough expectation of `samples.latency_ms`, since a poll makes
two requests. If the doubled figure is anywhere near the 10-second transport timeout, the region
choice is wrong and should be revisited before Phase 1.

---

## 6. Bun 1.4 or newer, if you build outside Docker

This does not apply to `docker compose build`, which uses `oven/bun:1` from the image
(`Dockerfile:2`). It applies if you run `bun install` or `bun run build` directly on the VPS or on
a separate build machine.

`bun.lock` is `lockfileVersion: 2` and `package.json:45-47` declares `"engines": { "bun": ">=1.4" }`.
Bun 1.3.x cannot parse that lockfile: it warns `UnknownLockfileVersion`, **silently ignores the
lockfile**, and rewrites it as v1 with around 60 transitive dependencies floated to newer patch
versions. Because the Dockerfile runs `bun install --frozen-lockfile` at both
`Dockerfile:5` and `Dockerfile:13`, the rewrite then fails the image build outright. Commit
`bd0b0e7` documents the exact failure; 1.4.2 is verified working and 1.3.11 verified failing.

```bash
bun --version    # must be >= 1.4
```

If `git status` shows `bun.lock` modified after an install you did not intend as an upgrade, your
bun is too old. Upgrade it and `git checkout -- bun.lock`.

One related note for the build machine: `Dockerfile:2` pins only the **major** version,
`oven/bun:1`. If that tag ever resolves to a 1.3.x build the image build breaks for the same
reason. Pinning `oven/bun:1.4` or a digest in the deploy artefacts removes that exposure.

---

## 7. Record these before moving on

Phase 2 needs all four. Put them somewhere durable, not in shell history.

| Item | Where it came from | Why Phase 2 needs it |
| --- | --- | --- |
| The `routes` array, verbatim | `GET /v1/capabilities` | Feature detection branches on it (`actions.ts:145-146`) |
| `limits.maxRequestsPerMinutePerIp` | `GET /v1/capabilities` | Sets the floor under `POLL_SECONDS` |
| Region, and the VPS public IP | Provider console | The IP is what xREALM allowlists; changing it breaks polling |
| Measured median latency to `/v1/status` | Section 5.4 | The baseline `samples.latency_ms` is compared against |

---

## 8. Acceptance criteria

Phase 0 is complete when all of these are true.

- [ ] VPS provisioned at 2 vCPU / 4 GB / 60 GB, or a smaller box with the build moved off it and
      `docker-compose.yml` switched from `build: .` to a pinned `image:`.
- [ ] `docker --version` and `docker compose version` both succeed.
- [ ] The static public IPv4 address is recorded.
- [ ] An A record for the panel hostname (D3, default `stats.refx.gg`) resolves to that address.
- [ ] Inbound 80, 443 and SSH are open; **3000 is not reachable from outside the host**.
- [ ] `curl http://<xrealm-host>:7776/v1/status` **from the VPS** returns JSON containing
      `serverName` and `players`.
- [ ] `GET /v1/capabilities` returns, and the `routes` array is saved verbatim.
- [ ] `limits.maxRequestsPerMinutePerIp` is recorded, or its absence is noted explicitly.
- [ ] Median `/v1/status` latency from the VPS is recorded and is comfortably under 5 seconds
      (half the 10-second transport timeout).
- [ ] If any build will happen outside Docker: `bun --version` reports 1.4 or newer.

## 9. Kill criteria

Stop and resolve, rather than proceeding and hoping.

- **The RCON port is unreachable from the VPS, or xREALM restricts it by IP.** Nothing downstream
  works. The panel talks to the listener from its own process and there is no alternative path; a
  panel that cannot poll has no analytics, no triggers, no status boards and no operator actions.
  This must be resolved with xREALM first, and it is the same conversation as **D1**
  (`CLAUDE.md:184`, still open) — whether the RCON password crosses the internet in cleartext or a
  tunnel is stood up first. Do not treat an IP restriction as a blocker to route around; it is the
  prompt to decide D1 deliberately.

- **`/v1/status` answers on HTTPS rather than HTTP.** The documented transport is plain HTTP/1.1
  and the official console only ever uses `http://` (`docs/wardogs-api.md:11-16`). An HTTPS
  response means something undocumented is fronting the listener — a reverse proxy, a provider
  gateway, a CDN. That is not necessarily bad, and the panel does support an `https` scheme, but
  you no longer know what is between the panel and the game server, what it does to headers, or
  whether it will still be there next month. Find out what it is before building on it.

- **Median latency is close to the 10-second transport timeout.** Polls will fail intermittently
  and three consecutive failures close every open player session on that server
  (`poller.ts:46`, `:179-183`), which puts wrong data in the tables rather than no data. Change
  region before Phase 1, not after.

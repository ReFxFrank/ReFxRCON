# Phase 4: Production deploy

**Goal: the panel on the VPS behind TLS, with the admin team on it and a restore path that has
actually been tested.**

> **Back up `ENCRYPTION_KEY` out of band before anything else in this phase.** Every stored RCON
> password is AES-256-GCM encrypted under it (`src/lib/server/crypto.ts:46-51`, blob format
> `v1.<base64 iv>.<base64 ciphertext‖tag>`). Lose the key and the panel greets you with
> `Could not decrypt a stored server password. Has ENCRYPTION_KEY changed?`
> (`src/lib/server/crypto.ts:69-73`) and every server has to be re-added by hand. A database
> backup without the key is worthless: the ciphertext restores perfectly and decrypts to nothing.
> Copy the key somewhere that is not the VPS and not the same store as the dumps, today, before
> you put a real RCON password into the panel.

> **What has and has not been verified.** This runbook was written without a VPS, without a live
> xREALM RCON endpoint and without a deployment target. Nothing in it has been executed end to
> end. What _was_ verified: every line number, default, error string, log line and address range
> quoted here was read out of this repository and is exact — `parseOrigin()`, the `XFF_DEPTH`
> arithmetic in the Node adapter, the `/setup` route's behaviour, the `classifyV4` ranges, the
> `/api/health` response body, the crypto error strings. What was not: the provisioning, the
> network path from the VPS to xREALM, TLS issuance, and the deploy itself. Treat the constants
> as reliable and the procedure as untested.

Phase 0 (`docs/refx/phase-0-provision.md`) is a prerequisite. This phase assumes the hostname
resolves to the VPS, 80 and 443 are open, 3000 is not, and the RCON gate passed.

---

## 1. `ENCRYPTION_KEY`, in full

### What it protects

Three columns, not one. All of them are bearer credentials, and all of them fail the same way.

| Column | What it holds | Written at | Read at |
| --- | --- | --- | --- |
| `servers.password_enc` | The RCON password, a full-access token | `src/lib/server/servers.ts:157`, `:201` | `src/lib/server/rcon.ts:40` |
| `webhooks.url_enc` | A Discord channel webhook URL | `src/lib/server/webhooks.ts:116`, `:151` | `src/lib/server/webhook-delivery.ts:265` |
| `status_boards.url_enc` | The status-board channel webhook URL | `src/lib/server/status-board.ts:111`, `:155` | poller hook |

The webhook cases matter because the error message names only the server password. A Discord
mirror that stopped posting after a restore reports `Could not decrypt a stored server password`,
which sends you looking in the wrong place.

### The three exact failure strings

| Cause | Error | Source |
| --- | --- | --- |
| Key missing, or not base64 of exactly 32 bytes | `ENCRYPTION_KEY secret is missing or is not base64 of 32 bytes. Set it in .env (openssl rand -base64 32).` | `src/lib/server/crypto.ts:36-40` |
| Key changed since the value was written | `Could not decrypt a stored server password. Has ENCRYPTION_KEY changed?` | `src/lib/server/crypto.ts:69-73` |
| The stored blob is not `v1.<iv>.<ct>` | `Unknown secret format.` | `src/lib/server/crypto.ts:54-56` |

All three are `ApiError` with status 500 and code `config`.

### Two behaviours that decide how you check the deploy

**A missing key does not stop the process.** `src/hooks.server.ts:33-35` validates the key only
when it is set:

```
33 	if (env.ENCRYPTION_KEY)
34 		encryptionKey(env); // fail at startup, not on the first server add
35 	else console.warn('[warcon] ENCRYPTION_KEY is not set; servers cannot be added.');
```

So an unset key boots cleanly, `/api/health` returns 200, and the failure appears days later the
first time somebody adds a server. **Grep the startup log for that warning; do not treat a healthy
health check as proof the key is present.**

**A malformed key does stop it**, at the same point, with the "not base64 of 32 bytes" error.

The placeholder check only covers `BETTER_AUTH_SECRET` (`crypto.ts:10-24`). Leaving
`ENCRYPTION_KEY=replace-with-openssl-rand-base64-32` in place is caught only incidentally, because
that string decodes to 26 bytes rather than 32 — the message you get is the generic length error,
not a placeholder warning.

### Generate and store it

```bash
openssl rand -base64 32
```

Put it in `.env` on the VPS, and put a copy in a password manager or an offline store that the
database dumps are not in. `docs/refx/backup.sh` writes it beside each dump for the same reason,
which covers the "restored the dump, forgot the key" case but not the "lost the machine and the
backup store together" case.

Once servers exist, the key cannot be rotated without re-entering every RCON password and every
Discord webhook URL by hand. There is no re-encrypt path in the codebase.

---

## 2. The artefacts that ship with this runbook

Do not write these from scratch; they are already in `docs/refx/` and carry the reasoning in their
comments.

| File | What it is |
| --- | --- |
| `docs/refx/Caddyfile` | The reverse proxy, TLS, the `X-Forwarded-For` handling and the header rules |
| `docs/refx/docker-compose.prod.yml` | The production Compose file, with **no** published app port |
| `docs/refx/env.production.example` | The `.env` template, annotated with each variable's failure mode |
| `docs/refx/backup.sh` | Nightly `pg_dump` plus the secrets beside it |
| `docs/refx/restore-test.sh` | Restores a dump into a scratch container and decrypts the passwords |

```bash
mkdir -p /opt/refxrcon && cd /opt/refxrcon
# the checkout goes here; then:
cp docs/refx/docker-compose.prod.yml ./docker-compose.prod.yml
cp docs/refx/Caddyfile               ./Caddyfile
cp docs/refx/env.production.example  ./.env && chmod 600 .env
```

**One edit is required in `Caddyfile` before it will work with the shipped Compose file.** The
Caddyfile ships with `reverse_proxy 127.0.0.1:3000`, which is correct when Caddy runs on the host.
`docker-compose.prod.yml` runs Caddy as a service in the same project, where `127.0.0.1` is
Caddy's own container. Change that line to the service name:

```
reverse_proxy refxrcon:3000
```

If you would rather run Caddy on the host, do the opposite: delete the `caddy` service, add
`ports: ['127.0.0.1:3000:3000']` to the app service, and leave the Caddyfile as shipped. Both
arrangements keep port 3000 off the public interface; pick one and be able to say which.

---

## 3. Caddy in front, and removing the published port

### Why the port mapping must go, not be firewalled

The repository's `docker-compose.yml:12-13` publishes `'3000:3000'` on every interface. That is
right for a laptop and wrong for a VPS, and **a firewall rule is not an equivalent fix**. Docker
publishes ports by inserting rules into the `DOCKER` chain, ahead of most hand-written `INPUT`
rules, so a `ufw deny 3000` frequently does not do what its author believes it does. Removing the
mapping means there is no listener on the public interface to reason about at all.

Two separate things break while port 3000 is reachable from outside:

- **Client-IP spoofing.** Once `ADDRESS_HEADER` is set (section 5), the app trusts a request
  header for the client address. Anyone who can reach 3000 directly sets that header themselves
  and chooses which address the audit log records and which rate-limit bucket they land in.
  `README.md:151-153` says this outright.
- **Cross-site form rejection.** A page served over plain HTTP has an HTTP origin, and the trusted
  origin list is exactly `[ORIGIN]` (`src/lib/server/auth.ts:203`). Every form post on such a page
  is rejected. The symptom is "the pages load, nothing I do works", which does not look like a
  port problem.

`docs/refx/docker-compose.prod.yml` has no `ports:` on the app or the database; only Caddy
publishes anything (80, 443, and 443/udp for HTTP/3). The app and the database sit on separate
Docker networks, with Caddy on the app's network and not on the database's.

### Do not let the proxy filter request headers

Every non-GET request to `/api/*` must carry `X-Requested-With: warcon` or
`src/hooks.server.ts:71-78` answers 403 with code `csrf`:

```
{"ok":false,"error":{"message":"Missing X-Requested-With: warcon header.","code":"csrf"}}
```

A proxy configured to forward only "known" headers breaks the entire JSON API while every page
still renders. Caddy passes headers through by default; the shipped Caddyfile only adds
`X-Forwarded-For`, `X-Forwarded-Proto` and `Host`.

Equally, do not set the security headers at the proxy. The app sets `x-content-type-options`,
`x-frame-options`, `referrer-policy` and `x-robots-tag` on every response
(`src/hooks.server.ts:12-18`, applied at `:43-47`). `referrer-policy` is deliberately
`same-origin` rather than `no-referrer`, because browsers send `Origin: null` on form posts under
`no-referrer` and SvelteKit rejects that as cross-site. Hardening it at the proxy breaks sign-in.

### Bring it up

```bash
cd /opt/refxrcon
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f refxrcon
```

The build peaks around 1.6 GB RSS; on a 2 GB box with no swap the OOM killer takes it during
`vite build` and reports only exit 137. Phase 0 covers building elsewhere and pulling an image
instead.

Watch for these three lines before doing anything else:

```
[warcon] database ready (timescaledb on)
[warcon] analytics poller every 20s
[warcon] this instance is the analytics poller
```

Then confirm the certificate and that 3000 is unreachable:

```bash
curl -sSI https://stats.refx.gg/            | head -1
curl -sS  http://stats.refx.gg/ -o /dev/null -w '%{http_code} %{redirect_url}\n'
curl -sS --max-time 5 http://<vps-public-ip>:3000/   # must time out, from OFF the box
```

Port 80 stays open permanently. Caddy needs it for the ACME challenge at every renewal, not only
at first issue. The `caddy-data` volume holds the certificates and the ACME account; losing it
means re-issuing, which is rate-limited by the CA.

---

## 4. `ORIGIN`

Set it to the exact URL people open, and nothing else:

```
ORIGIN=https://stats.refx.gg
```

`parseOrigin()` (`src/lib/server/env.ts:92-105`) requires `new URL(raw).origin === raw` and an
`http:` or `https:` protocol. It runs first in `initEnv()` (`env.ts:133`), before the auth secret
check and before the database connect, so a bad value means the container never serves at all:

```
ORIGIN must be the exact URL people open, e.g. https://rcon.example.com or http://localhost:5173 (got "https://stats.refx.gg/").
```

These were run through the parser and measured:

| Value | Result | Why |
| --- | --- | --- |
| `https://rcon.example.com` | accepted | |
| `http://localhost:3000` | accepted | A non-default port is part of the origin |
| `https://rcon.example.com/` | **rejected** | Trailing slash; `url.origin` has no slash |
| `https://example.com:443` | **rejected** | Explicit default port; `url.origin` drops it |
| `http://example.com:80` | **rejected** | Same, for HTTP |
| `https://EXAMPLE.com` | **rejected** | `url.origin` lowercases the host, so it no longer equals the raw string |
| `https://stats.refx.gg/panel` | **rejected** | A path is not part of an origin |

Three things downstream read it:

- **Cookie `Secure` flag** — `src/lib/server/auth.ts:199` is
  `useSecureCookies: env.ORIGIN.startsWith('https://')`. An `http://` origin means session cookies
  are not marked `Secure`.
- **Trusted origins** — `auth.ts:203` is `trustedOrigins: [env.ORIGIN]`. Exactly one. A form post
  whose `Origin` header is anything else is rejected.
- **Auth base URL** — `auth.ts:110`, which is what OAuth redirects are built from.

This is why the proxy must redirect HTTP to HTTPS rather than serving both. Caddy does that
without being asked, and the shipped Caddyfile deliberately has no `http://` block.

**Under Compose, mind which file wins.** The repository's `docker-compose.yml:18-24` sets `ORIGIN`
and all five `PG*` variables in its `environment:` block, which overrides `env_file: .env` — so
putting `PGHOST` in `.env` there does nothing. `DATABASE_URL` still wins over the `PG*` fields,
because `databaseTarget()` checks it first (`env.ts:114-129`). `docs/refx/docker-compose.prod.yml`
keeps `ORIGIN` out of its `environment:` block on purpose, so it comes from `.env` and there is
one place to look.

---

## 5. `ADDRESS_HEADER` and `XFF_DEPTH`

```
ADDRESS_HEADER=x-forwarded-for
XFF_DEPTH=1
```

Neither variable appears in `src/lib/server/env.ts`. They are read by SvelteKit's Node adapter at
`node_modules/@sveltejs/adapter-node/files/handler.js:19-20`; the only references in this
repository's own source are a comment at `src/lib/server/http.ts:97` and the docs. Do not go
looking for them in the app's config code.

### What `XFF_DEPTH` actually means

`handler.js:139` is:

```
139 return addresses[addresses.length - xff_depth].trim();
```

**It indexes from the END of the comma-separated list, 1-based.** It is not "skip N entries from
the left", and it is not a zero-based index.

- `XFF_DEPTH=1` → the **last** entry → the address appended by the proxy nearest the app, i.e. the
  peer that connected directly to that proxy.
- `XFF_DEPTH=2` → the second from last.

The list is only split on commas when `ADDRESS_HEADER` is literally the string `x-forwarded-for`
(`handler.js:125`). For any other header name the whole value is returned verbatim and `XFF_DEPTH`
is ignored — so setting `XFF_DEPTH` next to `x-real-ip` is a no-op that looks like configuration.

### The three cases

| In front of the app | Setting | Why |
| --- | --- | --- |
| Caddy only, as in `docs/refx/Caddyfile` | `ADDRESS_HEADER=x-forwarded-for`, `XFF_DEPTH=1` | Caddy appends the immediate peer — the real client — so it is the last entry. Depth 1 is also the adapter's default |
| Cloudflare → Caddy → app | `ADDRESS_HEADER=cf-connecting-ip` (preferred), or `x-forwarded-for` with `XFF_DEPTH=2` | The header arriving at Caddy already carries the real client from Cloudflare, and Caddy appends Cloudflare's edge address. The last entry is therefore Cloudflare. `cf-connecting-ip` is taken verbatim and cannot be off by one |
| nginx with `proxy_set_header X-Real-IP $remote_addr;` | `ADDRESS_HEADER=x-real-ip` | No splitting; the whole value is used |

Getting the Cloudflare case backwards records Cloudflare's edge address as every user's IP. That
is not cosmetic: the per-IP login lockout is 40 failures in 30 minutes
(`src/lib/server/access.ts:421`), and with one address for the entire internet that budget is
shared by everyone.

### The silent failure mode

If `ADDRESS_HEADER` names a header the request does not carry, or `XFF_DEPTH` overruns the list,
`handler.js:115-133` throws. `resolveClientIp()` swallows it:

```
100 export function resolveClientIp(socketAddress: () => string): string {
101 	try {
102 		return socketAddress();
103 	} catch {
104 		return '';
105 	}
106 }
```

(`src/lib/server/http.ts:100-106`.) Nothing returns 500. The address becomes the empty string, and:

- `audit_log.ip` is written blank (`src/lib/server/audit.ts:82`);
- public rate limiting keys on `public:unknown` (`src/lib/server/public.ts:56-57`), so **every
  affected request shares one 120-per-minute bucket**;
- sign-in and sign-up throttling key on `ip:unknown` and `signup:unknown`
  (`src/routes/(auth)/sign-in/+page.server.ts:38`, `src/lib/server/signup.ts:69`), collapsing the
  per-address lockout the same way.

`src/hooks.server.ts:52-53` overwrites `x-warcon-client-ip` on every request, so a client cannot
forge the value — provided it cannot reach the app without passing the proxy. That is section 3's
job.

### Verify it, because nothing will tell you

Sign in from a known address, then read the audit trail:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U refxrcon -d refxrcon -c \
  "SELECT created_at, action, outcome, ip FROM audit_log ORDER BY id DESC LIMIT 20;"
```

Real client addresses mean it is right. Blank `ip` on your own sign-in means it is wrong.

**Expect some blank rows regardless.** The container's own `HEALTHCHECK` (`Dockerfile:18`) calls
`http://127.0.0.1:3000/api/health` directly, bypassing the proxy and therefore carrying no
forwarded header. That request takes the empty-string path every 30 seconds. It is harmless, but
it means "there are blank IPs in the table" is not by itself evidence of a misconfiguration —
check which requests they belong to.

---

## 6. First run: `SETUP_TOKEN`

Set it to a one-time secret before the first start:

```
SETUP_TOKEN=$(openssl rand -base64 24)
```

Then open `https://<hostname>/setup` and create the owner account.

### Exactly what the route does with it

`src/routes/(auth)/setup/+page.server.ts`:

- `load` (`:10-14`) redirects 303 to `/sign-in` when `userCount > 0`, and otherwise returns
  `{ tokenRequired: !!env.SETUP_TOKEN }`. The token field only renders when that is true
  (`+page.svelte:53-56`).
- The action re-checks the user count first (`:25-26`) and returns
  `fail(409, 'Setup already completed.')`.
- Then, and only if `SETUP_TOKEN` is set, it compares the submitted value with
  `timingSafeEqualStr` (`:28`). A mismatch writes an audit row —
  `category: 'auth'`, `action: 'setup'`, `outcome: 'denied'`, `message: 'Bad setup token'` — and
  returns `fail(403, 'Setup token is wrong.')`.
- On success it creates the account with `role: 'owner'` (`:39-45`), writes an `ok` audit row with
  `message: 'Owner account created'`, signs the browser in and redirects to `/`.

`timingSafeEqualStr` (`crypto.ts:27-31`) returns false on any length mismatch, so the token's
length leaks and its contents do not.

Related: `/sign-in` redirects to `/setup` while there are zero users
(`sign-in/+page.server.ts:24`), and self-registration is refused until the owner exists —
`signup.ts:87-91` returns `fail(409, 'This panel has not been set up yet. Open /setup first.')`.

### What happens if it is left set

Nothing, while any user exists. The gate is `userCount > 0`, not the token: `GET /setup`
redirects, and a direct POST fails with 409 before the token is ever compared. `SETUP_TOKEN`
becomes inert.

**This is the one place where the build brief and the measured behaviour pull in different
directions, so decide it rather than inheriting it.** The brief's acceptance list says to remove
the token after owner setup, and that is a reasonable instinct: one fewer secret in `.env`, and
nobody a year from now has to work out whether it still matters. Against that: the token becomes
live again the moment the `user` table is empty, which is exactly the state a restore into a fresh
database produces. With no token set, whoever reaches `/setup` first on a freshly restored
instance becomes site owner.

The recommendation here is to **keep it**, and to treat the brief's checklist item as satisfied by
recording the decision. If you do remove it, make "set `SETUP_TOKEN` before starting the app" the
first line of the restore procedure, and put that in the same place as the dumps.

---

## 7. Harden the production `.env`

```
ALLOW_DEMO_SERVER=false
ALLOW_ORG_SIGNUP=false
```

**`ALLOW_DEMO_SERVER` defaults on.** `src/lib/server/env.ts:156` is
`ALLOW_DEMO_SERVER: processEnv.ALLOW_DEMO_SERVER ?? 'true'`. If you never mention it, anyone who
can add a server can add host `demo` with password `demo` and get the built-in mock game server
from `src/lib/server/mockgame.ts` — and a demo-host server **bypasses the host policy entirely**
(`src/lib/server/servers.ts:67` skips host normalisation, `:86` skips `assertReachableTarget`).
It must be set explicitly in production.

`ALLOW_ORG_SIGNUP` already defaults to false (`src/lib/server/signup.ts:12-13`). Set it anyway, so
the intent is on the record rather than inherited from a default that could change. With it on,
`/sign-up` lets strangers create accounts and their own organisations on your panel, three per
person.

Both are read through `flag()` (`env.ts:48-49`), which treats only `1`, `true`, `yes` and `on` as
true, case-insensitively, and an empty value as the fallback. So `ALLOW_DEMO_SERVER=FALSE`,
`=0`, `=no` and `=` all end up false — but do not rely on that; write `false` and mean it.

While you are in the file, confirm `POLL_SECONDS` is a positive number. `pollSeconds()`
(`env.ts:58-61`) turns an empty, non-numeric or negative value into 0, which disables the poller,
and with it sampling, triggers, status boards and the hourly `prune()`. The only signal is one log
line: `[warcon] analytics poller disabled (POLL_SECONDS=0)`. Values 1 to 4 are silently raised to
the floor of 5.

---

## 8. Invite the admin team

### The three layers

Access is three separate things, and conflating them is how people end up with more rights than
intended.

| Layer | Stored in | Values | Grants |
| --- | --- | --- | --- |
| Global role | `user.role` | `owner` and the rest | Site owner runs the whole panel: every account, every org, the full audit trail, and private RCON targets (section 11) |
| Organisation membership | `org_members.role` (`schema.ts:155`) | `owner`, `member` | An org owner manages that org's servers, members, invite links, Discord webhooks and audit trail. A member gets nothing except their per-server grants |
| Per-server grant | `server_grants.role` (`schema.ts:227`) | `viewer`, `operator`, `admin` | Ranked `viewer` 1, `operator` 2, `admin` 3 (`src/lib/server/access.ts:40`) |

What each server grant can do, from the role table in `README.md:188-195`:

| Grant | Can |
| --- | --- |
| `viewer` | Read everything: status, players, rotation, bans, reserved slots, the config document, the server log, analytics, dossiers |
| `operator` | Broadcast, whisper, kick, kill, change team, end or restart a match, change map, live rotation edits, notes and watchlist |
| `admin` | All of the above plus ban and unban, reserved slots, score tick, rotation mode, save rotation, sponsor image, **config apply**, and raw `/v1` calls |

**Give moderators `operator`.** Reserve `admin` for the small number of people who should be able
to replace the server configuration — `config apply` and the raw `/v1` action are the whole
server, not a subset of it. The raw action is itself limited to `/v1/` paths on the server's own
port (`hostpolicy.ts:168-181` rejects anything else, along with `..` and percent-encoded dots),
but within that it is unrestricted.

### The invite flow

As org owner: **Orgs → your org → New invite link**, pick the role joiners get, and paste the link
into Discord. Invite links are `<ORIGIN>/join/<token>` (`schema.ts:163`). People open it, sign in,
and appear under **Members**, where per-server roles are adjusted afterwards.

Invite links always allow account creation, with Discord or with a username and password. The
password form is throttled at 8 sign-ups per IP address per half hour and shares the
database-backed login-attempt table (`signup.ts:67-69`); add Cloudflare Turnstile with
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` if that form gets attention.

### Discord OAuth (D6)

D6's default is password accounts at launch with Discord added in this phase. With the community
Discord already in place it is the smoother path: an invite link creates the account on sign-in
and there is no password to distribute.

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
```

Both must be set or the provider stays off entirely (`env.ts:71-73`). The OAuth redirect to
register in the Discord developer portal is:

```
https://<hostname>/api/auth/callback/discord
```

That path is one of only three under `/api/auth` that a browser can reach; everything else there
returns 404 by design (`AUTH_PUBLIC` at `src/hooks.server.ts:23`, enforced at `:67`). The redirect
URI must match `ORIGIN` exactly, for the same reason `ORIGIN` itself must be exact.

New accounts appear through invite links; an existing password account can link Discord from its
Account page, and a Discord-created account can set a password there.

---

## 9. Backups, and a restore that has actually been run

### Nightly dump

`docs/refx/backup.sh` writes two artefacts and refuses to write only one: the dump, and a small
`.env` extract containing `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and `POSTGRES_PASSWORD`. It
writes the secrets **first**, so that a full disk fails before producing a dump that could not be
decrypted — a dump with no key beside it is worse than no dump, because it looks like a backup.

```bash
cp docs/refx/backup.sh /opt/refxrcon/backup.sh && chmod 700 /opt/refxrcon/backup.sh
BACKUP_DIR=/mnt/off-box /opt/refxrcon/backup.sh
```

```
17 3 * * * /opt/refxrcon/backup.sh >>/var/log/refxrcon-backup.log 2>&1
```

03:17 rather than 03:00 so it does not contend with everything else on the host that runs at the
top of the hour. It also records a `.sha256`, refuses a dump under 20,000 bytes (the shape a
container that died mid-stream produces while `pg_dump` still exits 0), and prunes dumps older
than `KEEP_DAYS`, default 30.

**Copy both files off the machine.** A backup that lives only on the box it backs up is a copy,
not a backup.

### What the dump must cover

Take a whole-database `pg_dump`, not a table list. There are 28 tables in `src/lib/server/db/schema.ts`,
**plus** Drizzle's migration bookkeeping table `__drizzle_migrations`, which lives in a separate
schema named `drizzle` (`node_modules/drizzle-orm/pg-core/dialect.js:45-46`, with the defaults
applied because `runMigrations` passes only a folder, `src/lib/server/db/index.ts:31-33`). A
`-t`-filtered dump misses it, and the next startup then replays all sixteen migrations from `0000`
against a populated database. `backup.sh` uses `pg_dump -Fc --clean --if-exists` on the whole
database for exactly this reason.

### What is not in the database, and a restore needs anyway

| Item | Consequence of not having it |
| --- | --- |
| `ENCRYPTION_KEY` | `servers.password_enc`, `webhooks.url_enc` and `status_boards.url_enc` are unrecoverable ciphertext. The panel looks healthy and cannot talk to a single game server |
| `BETTER_AUTH_SECRET` | Every row in `session` is invalid: everybody is logged out. Accounts and passwords survive — the hashes live in `account` |
| `ORIGIN` | Must match the URL people open, or every form post is rejected and cookies lose `Secure` |
| `POSTGRES_PASSWORD`, and the rest of `.env` | `SETUP_TOKEN`, `STEAM_API_KEY`, `DISCORD_CLIENT_ID`/`SECRET`, `TURNSTILE_*`, `POLL_SECONDS` — none of these are in Postgres |
| The TimescaleDB extension | `drizzle/0000_init.sql:173-175` creates the `samples` hypertable and its 90-day retention policy only `IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')`. Restoring hypertable data into plain Postgres changes both the physical layout and who prunes `samples` — the poller's fallback delete only runs when the extension is absent (`poller.ts:554`) |
| Caddy's `caddy-data` volume | The certificates and the ACME account. Recoverable by re-issuing, at the cost of a CA rate limit |
| The Compose volume layout | `refxrcon-db:/var/lib/postgresql`; PostgreSQL 18 images keep data in a **versioned subdirectory** of that path, which matters for any volume-level backup rather than a `pg_dump` |

### Restore it once, before declaring the phase done

```bash
/opt/refxrcon/restore-test.sh \
  /mnt/off-box/refxrcon-20260921T031700Z.dump \
  /mnt/off-box/refxrcon-secrets-20260921T031700Z.env
```

`docs/refx/restore-test.sh` brings up a throwaway Postgres on a random loopback port, verifies the
checksum, restores, counts tables, users, servers and samples, and then does the thing that
matters: it decrypts every `servers.password_enc` with the backed-up `ENCRYPTION_KEY`, using the
same AES-256-GCM framing `crypto.ts` writes. It removes the container on exit, including on
failure, and touches nothing in production.

It does not rely on `pg_restore`'s exit code: `--clean --if-exists` emits `DROP` statements for
objects that do not exist yet on a fresh database, so a successful restore reports errors. The row
counts and the decryption are the real assertions.

**Run it after at least one real server exists.** With zero servers the script says so and passes
without proving anything about the key — a restore that reproduces the rows but not the plaintext
is a restore of an unusable panel, and the difference is invisible until someone tries to poll.

---

## 10. External uptime check

Point a monitor at:

```
https://<hostname>/api/health
```

The whole handler is three lines (`src/routes/api/health/+server.ts`):

```
1 import { apiJson } from '$lib/server/http';
2
3 export const GET = () => apiJson({ ok: true, service: 'refxrcon' });
```

It returns HTTP 200 with the body exactly:

```json
{"ok":true,"service":"refxrcon"}
```

and `cache-control: no-store` (`http.ts:16-17`) plus the four security headers. **It needs no
authentication and is not rate limited**, and the CSRF header guard does not apply because it only
covers non-safe methods.

`service` is a literal in that file, not `APP_NAME` — upstream it reads `warcon`, and this fork
has already changed it. **Assert on the status code and `"ok":true`, not on the service name**, or
the next rebrand takes the monitor down with it.

**Be clear about what a 200 proves.** The handler touches nothing: no database query, no poller
check, no RCON call. It proves the Bun process is accepting HTTP. Indirectly it proves that
`initEnv()` succeeded at startup and the migrations ran, because the process does not reach the
serving state otherwise. It does **not** prove Postgres is alive now — the session lookup in
`hooks.server.ts:82-93` is wrapped in `try`/`catch`, so with the database down the health check
still returns 200 while every real page fails and `session lookup failed:` appears in the log.

So pair it with something else: alert on the absence of `[warcon] database ready` and
`[warcon] analytics poller every 20s` at startup, and on a stale newest `samples.ts`.

---

## 11. The tunnel case (D1)

If D1 is resolved by tunnelling rather than by accepting cleartext, the RCON target stops being a
public address and the host policy refuses it. This is the single most likely deployment surprise
in the phase, and it has no environment variable.

### What counts as private

`classifyV4` (`src/lib/server/hostpolicy.ts:24-37`), in evaluation order:

| Range | Classified | Note |
| --- | --- | --- |
| `169.254.0.0/16` | **link-local** | Refused for everyone. There is no override |
| `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8` | private | WireGuard and provider LANs land here |
| `100.64.0.0/10` | private | Carrier-grade NAT — **this is Tailscale's range**, and people do not expect it |
| `172.16.0.0/12` | private | Includes `172.17.0.1`, which is what `host.docker.internal` usually resolves to |
| `192.168.0.0/16` | private | |
| `192.0.0.0/24`, `192.0.2.0/24` | private | IETF protocol assignments, TEST-NET-1 |
| `198.18.0.0/15` | private | Benchmarking |
| `198.51.100.0/24`, `203.0.113.0/24` | private | TEST-NET-2 and TEST-NET-3 |
| `224.0.0.0/3` | private | Multicast, reserved, broadcast |

On the IPv6 side (`hostpolicy.ts:65-80`), `fe80::/10` is link-local; `fc00::/7`, `ff00::/8`,
`2001:db8::/32`, `::` and `::1` are private. IPv4-mapped addresses such as `::ffff:10.0.0.5` and
the NAT64 prefix `64:ff9b::/96` are unwrapped and classified as their embedded IPv4.

A private target that is not allowed produces:

```
<host> resolves to <address>, a private address. Only publicly reachable game servers can be added here. If the game server shares a machine or network with this panel, ask the site owner to add it.
```

(403, code `blocked_host`, `hostpolicy.ts:154-160`; for a literal IP the sentence opens
`<host> is a private address...`.) Refusals are written to the audit log as `denied`
(`servers.ts:98-110`).

### The exact procedure

There is no config flag. The allowance comes from the role of whoever saves the target and is then
persisted on the row.

1. **Sign in as the site owner** — the account created by first-run `/setup`, or anyone it later
   promoted on the Users page. `mayUsePrivateHosts` is exactly
   `actor.role === 'owner'` (`src/lib/server/servers.ts:46`). An organisation owner cannot do this
   and gets the 403 above.
2. **Add or edit the server so that host, port or scheme is written.** `targetChanged`
   (`servers.ts:79-82`) covers all three. `assertReachableTarget` then runs with
   `allowPrivate = true` and the row is saved with `allow_private = true` (`servers.ts:83-87`,
   column at `schema.ts:206`).
3. **Afterwards anyone may use it.** The per-request re-check reads `allow_private` from the row,
   not from the current actor (`src/lib/server/rcon.ts:122-141`), so the poller and every operator
   work normally.

If the row already exists with `allow_private = false`, a site owner saving it **without** changing
the target flips the flag anyway (`servers.ts:88-92`) — saving it is taken as vouching for it.

### Two traps

- **Port edits.** Changing only the port of an existing private target counts as `targetChanged`
  and re-runs the check as the current actor. An org owner editing a site-owner-added private
  server's port is refused and the edit fails. Port changes on private targets are a site-owner
  job.
- **`host.docker.internal`.** It resolves to a private address, so the site-owner step is still
  required, **and** the container needs the mapping. `docker-compose.yml:25-27` ships it commented
  out; uncomment it on the app service in your production Compose file:

  ```yaml
  extra_hosts:
    - 'host.docker.internal:host-gateway'
  ```

A Cloudflare Tunnel or a TLS proxy that terminates on a **public** DNS name needs none of this: the
target classifies as public and any org owner may add it. `README.md:415-421` documents that
pattern.

Outbound RCON requests carry a 10-second timeout (`src/lib/server/transport.ts:47`) and
`redirect: 'manual'`; an unreachable host produces `Could not reach <host>:<port> (<code>).`

---

## Decisions that landed on this phase

Two of the register's decisions are now closed, and both create work here rather than just a
setting.

### D1 — accept the cleartext credential, and rotate

Accepted: the RCON password crosses the internet in cleartext roughly 4,300 times a day per
server, and it authorises everything. That is a legitimate choice, and it is only legitimate if
the rotation happens.

- [ ] **Rotate every server's RCON password immediately after setup.** By the time a server is
      live the password has been through a browser, a terminal and at least one chat message.
- [ ] **Write the rotation interval down** somewhere that is not a file in this repository.
      Monthly is a reasonable default; "when we remember" is not an interval.
- [ ] Confirm the first rotation went through cleanly: one `ok = false` sample at the moment of
      the change, and sampling resumes on the next tick. No restart is needed.

The full procedure, including the off-schedule triggers and what rotation does *not* fix, is in
`docs/refx/security.md`.

### D4 — public pages on, everything

Status, leaderboards and career pages are public. There is no environment variable: the switches
are per-org and per-server in the UI, and **both** levels must be on.

- [ ] Organisation → Features: allow public status, allow public stats.
- [ ] Server → Features: public status, public stats. Per server, so you can stage it.
- [ ] **Decide the rate-limit story before announcing the URL**, not after. Measured on this
      codebase: the routes are cheap (leaderboard 11 ms p50, 29 ms p95 at 10 concurrent on
      129,614 samples) and the limiter works — but its budget is 120 requests per 60 seconds
      **per client address**, shared between the JSON routes and the page loads, and the public
      page polls every 10 seconds. **Twenty-one viewers behind one CGNAT address all get 429s.**
      Either put a cache in front that honours the status route's `max-age=5`, or raise the limit
      in `src/lib/server/public.ts`.
- [ ] Do **not** scale the app container. The limiter is in-process; a second replica doubles the
      effective limit, and with D4 on it is the only thing in front of unauthenticated,
      database-backed routes.
- [ ] Remember it resets on every deploy. A quiet traffic graph after a release may be the
      buckets clearing rather than the traffic stopping.


## 12. Acceptance criteria

Phase 4 is complete when all of these are true.

- [ ] `ENCRYPTION_KEY` is backed up out of band, in a place that is not the VPS and not the same
      store as the database dumps.
- [ ] A valid certificate is served on the hostname, and `http://` redirects to `https://`.
- [ ] Session cookies carry `Secure`, which follows from `ORIGIN` starting with `https://`.
- [ ] `curl http://<vps-ip>:3000` from outside the host times out, and the app service in the
      production Compose file has no `ports:` mapping at all.
- [ ] The audit log records real client IPs for browser requests, not the proxy's and not blank.
      If this is wrong, rate limiting and every ban attribution are wrong with it.
- [ ] `docker compose -f docker-compose.prod.yml restart` brings the poller back: the log shows
      `[warcon] this instance is the analytics poller` again and sampling resumes with no gap
      beyond the restart.
- [ ] A backup has been restored onto a scratch container with `restore-test.sh`, with at least
      one real server in it, and the stored passwords decrypted there.
- [ ] `ALLOW_DEMO_SERVER=false` and `ALLOW_ORG_SIGNUP=false` are both set explicitly in `.env`.
- [ ] The `SETUP_TOKEN` decision is recorded — removed per the brief, or deliberately kept with
      the restore hazard in section 6 understood.
- [ ] The admin team is on the panel with `operator` on the servers they work, and `admin` held by
      the people who should be able to replace the server config.
- [ ] An external uptime check polls `/api/health`, and something also alerts on the absence of
      `[warcon] database ready` and `[warcon] analytics poller every 20s` at startup.
- [ ] The nightly backup job has run unattended at least once and left both a dump and a secrets
      file off the box.

## 13. Kill criteria

Stop and resolve, rather than proceeding and hoping.

- **The restore test fails to decrypt stored passwords.** Stop and resolve the key-handling story
  before putting real credentials in. A backup regime that reproduces rows but not plaintext is
  not a backup regime, and the difference only shows up on the day you need it.

- **Client IPs in the audit log are the proxy's, or blank, for browser requests.** Fix
  `ADDRESS_HEADER` and `XFF_DEPTH` before opening the panel to anyone else. Attribution is the
  entire argument for running a panel instead of sharing an RCON password, and while this is wrong
  the per-IP login lockout is wrong too.

- **Port 3000 answers from outside the host.** Every other control in this phase assumes it does
  not. Do not proceed on the strength of a firewall rule; remove the mapping.

---
## 14. Day two

### Log lines worth watching

They all still carry the upstream `[warcon]` prefix, so grep for that rather than for a ReFx
string. If the prefix is ever changed, this table and anything alerting on it change with it.

| Line | Where | Means |
| --- | --- | --- |
| `[warcon] database ready (timescaledb on)` | `env.ts:142` | Config parsed, connected, migrations applied. `off` means the extension is absent and `samples` is pruned by the poller instead |
| `[warcon] analytics poller every 20s` | `poller.ts:144` | The interval is set |
| `[warcon] analytics poller disabled (POLL_SECONDS=0)` | `poller.ts:131` | No sampling, no triggers, no status boards, **and no `prune()`**. Almost always a typo in `.env` |
| `[warcon] this instance is the analytics poller` | `poller.ts:118` | This process won the advisory lock |
| `[warcon] leader lock <err>` | `poller.ts:121` | The reserved connection failed; leadership was not acquired this tick |
| `[warcon] ENCRYPTION_KEY is not set; servers cannot be added.` | `hooks.server.ts:35` | The panel is up and cannot store a credential |
| `[warcon] BETTER_AUTH_SECRET is not set; the panel will refuse to serve pages.` | `hooks.server.ts:32` | Boot succeeded; every page will answer 503 |
| `session lookup failed:` | `hooks.server.ts:92` | Usually the database. `/api/health` keeps returning 200 through this |
| `[warcon] poll`, `[warcon] list sync`, `[warcon] ban list snapshot` | `poller.ts:138`, `:233`, `:222` | Per-tick failures against a game server |

```bash
docker compose -f docker-compose.prod.yml logs --since 24h refxrcon | grep '\[warcon\]'
```

### The rate limiter is per process

`src/lib/server/ratelimit.ts` is an in-memory sliding window. Its own header comment says it:
*"Per process: with several replicas the effective limit is that many times higher."* It also
resets on every restart and every deploy.

| Limiter | Budget | Keyed by |
| --- | --- | --- |
| Public JSON and public pages | 120 / 60 s | Client address (`public.ts:56-57`) |
| Raw `/v1` action | 30 / 60 s | User id (`rcon-run.ts:88`) |
| Connectivity test | 20 / 60 s | User id |
| Steam lookup | 20 / 60 s | User id |
| Status-board refresh, webhook test | 10 / 60 s | User id |

**A second replica doubles every one of these**, because each process keeps its own map. Page
loads and JSON polls share the public 120, so an HTML view and a poll both spend from it — which
matters if D4 ever turns public stats pages on. Run one replica, or move rate limiting to Caddy.

The exception is the login and sign-up throttle, which is database-backed in `login_attempts` and
therefore shared and durable across restarts: 8 failures per username or 40 per IP in a 30-minute
window produce a 15-minute lock (`src/lib/server/access.ts:418-467`). Sign-ups use the
`LOCK_AFTER_USER` limit of 8 per address, not 40.

### One replica, and restart after any Postgres restart

Leader election uses `pg_try_advisory_lock(7741221)` on a reserved connection
(`poller.ts:110-125`). Nothing ever unlocks it; the lock is released when the connection closes,
and another replica picks up leadership on its next tick, within `POLL_SECONDS`.

The flag is sticky, though: once `leader = true`, `ensureLeader` short-circuits at `poller.ts:111`
for the life of the process. If the reserved connection drops while the process survives — a
Postgres restart, a middlebox, a network blip — Postgres releases the lock but this process still
believes it is the leader and keeps polling, while another replica can now acquire it. That is a
genuine double-poll window. Mitigations, in order of preference: run exactly one app replica, and
restart the app after any Postgres restart.

Related: do not put a transaction-pooling PgBouncer between the app and Postgres. Session-level
advisory locks do not survive it, and the reserved connection is the mechanism.

### Growth

`samples` takes one row per server per tick — 4,320 rows per server per day at `POLL_SECONDS=20`.
`prune()` runs roughly hourly and only from the leader (`poller.ts:139`), deleting
`player_sessions`, `player_match_stats` and `matches` past 365 days, and `samples` past 90 days
**only when TimescaleDB is absent** (`poller.ts:551-563`). With the shipped
`timescale/timescaledb:2.30.0-pg18` image the in-database retention policy handles `samples`
instead. If the poller is off, none of it runs.

```bash
docker compose -f docker-compose.prod.yml exec -T db psql -U refxrcon -d refxrcon -c \
  "SELECT max(ts) AS newest_sample, count(*) FILTER (WHERE ts > now() - interval '1 hour') AS last_hour FROM samples;"
```

A `newest_sample` more than a couple of poll intervals old means the poller has stopped, whatever
`/api/health` says.

### Routine

- Rotate the RCON passwords after initial setup, and on a schedule if D1 was resolved by accepting
  cleartext. The password will have been typed into a browser, a terminal and at least one chat
  message by the end of this phase.
- Check that the nightly backup left two files, not one, and that both reached off-box storage.
- Re-run `restore-test.sh` after any schema change ships, and after any change to `crypto.ts` —
  the script hard-codes the `v1.<iv>.<ct>` framing and must be updated with it.
- Read the audit trail occasionally, and confirm the `ip` column still holds real addresses. When
  that quietly stops being true, nothing returns an error.

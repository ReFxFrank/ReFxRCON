# ReFx runbooks

Everything ReFx-specific about running this fork. The phases come from the build brief; each one
carries acceptance criteria to proceed on and kill criteria to stop on.

## What has been executed, and what has not

Be clear about this before following any of it.

| Phase | Status |
| --- | --- |
| **0 — Provision** | **Runbook only.** Written without a VPS. Not executed. |
| **1 — Fork and local bring-up** | **Done and verified.** See the repository history. |
| **2 — Live connection** | **Runbook only.** Written without a live xREALM endpoint. Not executed. |
| **3 — Reskin and rebrand** | **Done and verified** against the demo server. |
| **4 — Production deploy** | **Runbook and artifacts only.** Nothing was deployed. |
| **5 — Rotation-retention analytic** | **Done and verified** against seeded fixtures and reconciled in psql. |

The runbooks for 0, 2 and 4 are precise about the codebase — every line number, default, error
string and address range in them was read out of this repository. They are untested as
*procedures*, because there was no machine to test them on. Treat the facts as reliable and the
steps as a careful first draft.

## Phases

| | |
| --- | --- |
| [`phase-0-provision.md`](phase-0-provision.md) | Sizing, region, firewall, and the gate: prove the VPS can reach xREALM's RCON port before any code is written |
| [`phase-2-live-connection.md`](phase-2-live-connection.md) | Adding live servers, the request budget, and the ground-truth check that the data matches reality |
| [`phase-4-production-deploy.md`](phase-4-production-deploy.md) | TLS, client IPs, hardening, the admin team, and a restore that has actually been tested |

Phases 1, 3 and 5 are not runbooks because they are done. What they left behind:

- Phase 1 → [`../../CLAUDE.md`](../../CLAUDE.md), the decision register and the rules.
- Phase 3 → the `@theme` block and `@utility` bodies in `src/app.css`, and
  [`../../branding/README.md`](../../branding/README.md).
- Phase 5 → [`rotation-retention.md`](rotation-retention.md).

## Reference

| | |
| --- | --- |
| [`security.md`](security.md) | The posture; **D1** (accepted — with the rotation procedure that acceptance obliges); and the measured rate-limit numbers behind **D4** |
| [`rotation-retention.md`](rotation-retention.md) | What the retention number means, what it does not, and how to check it |
| [`rotation-retention.sql`](rotation-retention.sql) | A second, independent implementation of that analytic, for reconciling the panel by hand |

## Artifacts

Copy these into place; they are not wired up automatically.

| | |
| --- | --- |
| [`env.production.example`](env.production.example) | Annotated production `.env`. Every entry says what breaks if it is wrong, including the ones that fail silently |
| [`docker-compose.prod.yml`](docker-compose.prod.yml) | Production Compose. Differs from the repo's in that the app publishes **no ports** — Caddy is the only way in |
| [`Caddyfile`](Caddyfile) | TLS, HTTP→HTTPS, and the `X-Forwarded-For` handling that `XFF_DEPTH=1` expects |
| [`backup.sh`](backup.sh) | Nightly `pg_dump` **plus the secrets**, because a dump without `ENCRYPTION_KEY` restores to an unusable panel |
| [`restore-test.sh`](restore-test.sh) | Restores a backup to a scratch container and proves the stored RCON passwords decrypt. Phase 4 is not done until this passes |

The decryption check inside `restore-test.sh` was verified against real encrypted rows in a live
database: it recovers the plaintext correctly. The Docker orchestration around it was not — there
was no Docker daemon available.

## Decisions — all ten closed

| # | Decision | Where it landed |
| --- | --- | --- |
| D1 | Cleartext RCON credential | **Accept and rotate.** Creates an obligation: rotate after setup and on a written interval (`security.md`) |
| D2 | VPS specs | **2 vCPU / 4 GB / 60 GB.** 4 GB is the Docker build; runtime is near idle |
| D3 | Hostname | **`stats.refx.gg`** — in the Caddyfile, the env template and the Discord redirect |
| D4 | Public stats pages | **On, everything.** Read the measured rate-limit numbers in `security.md` before announcing the URL |
| D5 | Steam Web API key | **Yes.** Buys account age and VAC/game bans — not names, which `/v1/players` already returns |
| D6 | Admin sign-in | **Discord from the start.** Password accounts keep working alongside it |
| D7 | `EMAIL_SUFFIX` | **`@refx.gg`.** Was irreversible; applied before any account existed |
| D8 | Sample retention | **120 days**, not upstream's 90 — so the panels' 90-day window is honest. Code change, shipped |
| D9 | Poll interval | **20 s.** 6.4 requests/min/server, measured |
| D10 | Server count | **Moot.** At 6.4 req/min/server the per-org cap of 10 is 64/min; a 120/min limit needs ~19 servers |

Three of them created work rather than a setting, and that work is done: the rotation procedure
and its Phase 4 checklist (D1), the public-surface measurements and the no-scale constraint (D4),
and migration `0016_sample_retention_120_days.sql` with the matching poller constant (D8).

**Two still need something from you**, and neither can be done from here:

- **D1** — pick a rotation interval and write it somewhere that is not this repository, then
  rotate every server's password once immediately after setup.
- **D5 / D6** — provision the Steam API key and the Discord application. Both are env vars in
  `env.production.example`, with the exact steps beside them.

## The three things most likely to bite

1. **`ENCRYPTION_KEY`.** Every stored RCON password is AES-256-GCM encrypted under it, and it is
   not in the database. A dump without it restores to
   *"Could not decrypt a stored server password. Has ENCRYPTION_KEY changed?"* and every server
   has to be re-added by hand. Back it up out of band, today, before anything else.

2. **`ADDRESS_HEADER` and `XFF_DEPTH`.** `XFF_DEPTH` counts from the **end** of the header's
   list, 1-based — it is not "skip N from the left". Get it wrong and nothing returns an error:
   the recorded client IP is simply blank, and every affected request shares one rate-limit
   bucket. Check the audit log after the first deploy.

3. **`ALLOW_DEMO_SERVER` defaults to _on_.** It must be set to `false` explicitly, or host `demo`
   with password `demo` serves the built-in mock server — and a demo-host server bypasses the
   SSRF host policy entirely.

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

## Decisions, as they stand

| # | Decision | Status |
| --- | --- | --- |
| D1 | RCON password in cleartext | **Closed — accept and rotate.** Creates an obligation: rotate after setup and on a written schedule (`security.md`) |
| D3 | Hostname | **Closed — `stats.refx.gg`.** Already in the Caddyfile and the env template |
| D4 | Public stats pages | **Closed — on, everything.** Read the measured rate-limit numbers in `security.md` before announcing the URL |
| D7 | `EMAIL_SUFFIX` | **Closed — `@refx.gg`.** Was irreversible; applied before any account existed |
| D9 | Poll interval | **Closed — 20 s.** 6.4 requests/min/server, measured |
| D2, D5, D6, D8, D10 | VPS specs, Steam key, Discord OAuth, retention, server count | Open, running on their defaults. None of them block a deploy |

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

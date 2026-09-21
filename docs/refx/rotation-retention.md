# Rotation retention

**Which maps bleed players.** For each match, players at match start are compared against
players ten minutes in. Each map is scored on what is left of that difference once the things
that have nothing to do with the map are removed.

The number feeds one decision: what to put in `RotationEntries`.

- Panel: **Analytics → Rotation retention**, on any server page.
- API: `GET /api/servers/{id}/rotation-retention?range=30d&by=map` (viewer role).
- Code: `src/lib/server/rotation-retention.ts`. The statistics are a pure exported function,
  `scoreRotationRetention`, covered by `rotation-retention.test.ts`.
- Reproduce by hand: `docs/refx/rotation-retention.sql` — a second, independent implementation
  in SQL. It agrees with the panel to the cent.

## How to read it

A residual of **−3.22** means: over this map's first ten minutes, the server loses 3.22 more
players than it loses on the average map in this rotation, at the same time of week, from the
same starting population.

Three things that number is **not**:

1. **It is not an absolute.** Residuals are measured against the average map here, so they sum
   to zero across the rotation by construction. If *every* map bleeds, the bars still scatter
   about zero and still name a "worst". The sentence under the chart — "across all of them the
   server lost 0.76 players" — is what carries the absolute level. Read it first.

2. **It is not causal.** The interval describes sampling noise. Anything that varies
   systematically with rotation position and is not in the model will produce a stable,
   reproducible and entirely spurious ordering. Simulated with eight maps of identical true
   effect differing only in where they sit inside the hour, residuals ran from +0.47 to −0.52
   with two of them "significant".

3. **It is not per-experience.** A rotation entry changes map, experience and lighting together,
   so a map's score may really belong to its experience. `?by=map+experiences` splits them, but
   only use it where a pair clears the match threshold on its own.

**Do not act on a gap smaller than the intervals.** With ten to fifteen maps on screen the
multiplicity is real: if two maps' intervals overlap, they are not ranked, whatever order the
bars happen to be in.

## What it corrects for

| Confound | Why it matters | What the estimator does |
| --- | --- | --- |
| Time of day | A map that rotates in at 3am always looks terrible | Matches are bucketed into weekend-flag × hour-of-day (48 buckets) and a slot effect is fitted |
| Headroom | A full server cannot grow, so popular maps at peak look flat | Matches starting above 90% of `max_players` are excluded and counted |
| Starting population | Rotation is ordered, so each map has a fixed predecessor and a systematically different start; population reverts toward its time-of-day norm, so a map following a popular one bleeds through reversion alone | The excess of `ccu_start` over the slot's own norm enters as a covariate |
| The baseline containing the map being scored | **This one inverts answers** | Slot and map effects are fitted jointly, by back-fitting, rather than a slot average taken over the same rows being scored |

### The one that inverts answers

The obvious implementation — average the delta per time slot, then score each map on
observed minus that average — is wrong in a way that is invisible until you check it against
data whose truth you know.

A slot average taken over the same rows being scored is pulled toward whichever map dominates
that slot, by exactly `1 − n_map,slot / n_slot`. Measured on a fixture where one map held half
the rotation:

| Map | True effect | Naive slot baseline | This estimator |
| --- | --- | --- | --- |
| Kokan | −2.30 | −1.42 | **−2.27** |
| Dustbowl | −0.80 | **−0.08** | **−0.78** |
| Bridge | +0.70 | +1.27 | +0.61 |
| Harju | +0.70 | +1.26 | +0.72 |
| Narva | +1.70 | +2.32 | +1.72 |

Dustbowl is the second-worst map in that rotation. The naive estimator reports it at −0.08 —
indistinguishable from average, a map you would never think to touch. Every neutral map is
inflated by more than half a player at the same time.

`rotation-retention.test.ts` keeps both columns as a regression test, so the failure cannot
come back quietly.

## Confidence, and the null test

Standard errors are **clustered by day**: consecutive matches share a population wave and
largely the same players, so treating each match as an independent observation overstates
precision.

A 30-day window gives about 30 clusters, and the usual 1.96 critical value assumes infinitely
many. It is not close enough. Measured over 200 random half-splits of a single map on a
synthetic rotation, a normal critical value rejected **9–13%** of splits of a map against
*itself* — an estimator that calls identical halves different one time in eight. Against
`t(G−1)`, and clustering the difference rather than assuming the halves are independent, the
same test rejects 3.5–5.0%.

`nullTest()` implements the brief's acceptance criterion directly. It relabels one map's matches
into two pseudo-maps and rescores in **one** pass, so the slot fit, the population slope and
every other map are held fixed. Re-running the whole estimator on two subsets instead would
halve n twice over and refit the baseline differently under each half, and a disagreement could
not be attributed to anything.

Two things the null test cannot do:

- **It cannot be judged against the per-match spread.** Residual spread is around 0.7 players
  and the standard error of the mean is around 0.03. Judged against the spread, nothing is ever
  distinguishable and the test passes no matter what the estimator does.
- **It cannot catch a shared confound.** Both halves inherit it, so it passes every time. The
  null test validates the error bars, not the causal claim.

## Thresholds and exclusions

A map with fewer than **20 matches** shows its count and no residual. It is listed under "not
enough matches to score" rather than drawn as a zero bar, because a zero bar reads as "this map
is fine".

Sub-threshold matches still feed the fit — their slot information is useful — but the reported
zero is the unweighted average of the **scoreable** maps. A map that ran twelve times must not
re-baseline the maps that ran three hundred: on the seeded fixture, letting a 12-match map into
the reference shifted every other residual by 0.86 players.

Exclusions are counted and shown, because an empty panel otherwise looks like "no map
qualifies". Watch for `noCapacity` in particular: the poller records a missing `players.max` as
**0**, not null, so on an RCON build that omits it the headroom filter drops every match on the
server and the panel goes silently empty.

## Checking it against a server

```bash
# the panel
curl -s -b jar -H 'x-requested-with: warcon' \
  "$ORIGIN/api/servers/$SERVER/rotation-retention?range=30d" | jq .

# the same numbers, computed independently in the database
psql "$DATABASE_URL" -v server="'$SERVER'" -f docs/refx/rotation-retention.sql
```

To check it against data whose truth is known, seed a scratch server:

```bash
DATABASE_URL=... bun run scripts/seed-rotation-retention.ts <server-id> 30
```

That writes 30 days of synthetic matches and samples with a deliberate loser, both confounds
baked in, a weighted rotation, and one map below the threshold. It prints the ground truth it
generated, and refuses to run against a server that already has samples.

Last reconciled on that fixture: 2,159 matches, six maps. Panel and SQL agreed on every
residual, count and interval; both recovered the seeded truth to within 0.07 players.

## Windows and retention

The default window is 30 days. `samples` are pruned at 90 days (`SAMPLE_RETENTION_DAYS`), so
the 90-day option only works while that retention holds — **D8 makes retention a tunable, and
lowering it below about 32 days silently truncates the 30-day window from the far end rather
than erroring.**

`matches` are kept for 365 days, but a match without samples either side of it cannot be scored,
so sample retention is the binding constraint.

## If the null test ever fails

Do not ship a number people will rewrite their rotation on.

- **A random split fails** → the variance model is wrong. Check the clustering and the critical
  value before touching the point estimate.
- **A time split fails** (first half of the window against the second) → there is drift. Either
  add a time trend or shorten the window; the estimator assumes a map's effect is stable across
  the window.
- **Neither can be fixed** → fall back to reporting raw deltas, clearly labelled as unadjusted.
  A number with a caveat beats a number with a confidence interval it has not earned.

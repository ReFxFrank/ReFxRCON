-- Rotation retention, as SQL.
--
-- This is a SECOND, INDEPENDENT implementation of what
-- src/lib/server/rotation-retention.ts computes, kept so the panel's numbers can be reproduced
-- by hand and reconciled -- which is one of the build brief's acceptance criteria for Phase 5.
-- The panel does the statistics in TypeScript so they can be unit-tested (no test in this
-- repository can reach Postgres); this file does the same arithmetic in the database.
--
-- Run it:
--   psql "$DATABASE_URL" -v server="'<server-uuid>'" -f docs/refx/rotation-retention.sql
--
-- The two implementations agree to the cent on residual, matches and se. The interval may differ
-- in the last digit only through rounding.
--
-- Read docs/refx/rotation-retention.md for what the number means and what it does not.

\set ON_ERROR_STOP on

WITH p AS (
  SELECT :server::text     AS server_id,
         interval '30 days' AS win,
         'UTC'::text        AS tz,
         20::int            AS min_matches,
         0.90::numeric      AS headroom,
         interval '10 minutes' AS horizon,
         interval '2 minutes'  AS grab
),
-- Closed matches whose whole read window lies inside the match. `ended_at IS NOT NULL` is
-- load-bearing twice over: a live match has no ten-minute mark yet, and prune() deletes on
-- `ended_at < cutoff`, which NULL never satisfies, so matches abandoned by a poller that never
-- restarted would otherwise accumulate for ever and keep qualifying.
m AS (
  SELECT mt.id, mt.server_id, mt.map, mt.started_at, mt.ended_at
    FROM matches mt, p
   WHERE mt.server_id = p.server_id
     AND mt.map IS NOT NULL AND mt.map <> ''
     AND mt.started_at >= now() - p.win
     AND mt.ended_at IS NOT NULL
     AND mt.ended_at >= mt.started_at + p.horizon + p.grab
),
-- Both readings pinned to the match they belong to. started_at is back-derived as
-- (ts - matchSeconds), so it can precede the sample that first saw the match; without the
-- LEAST() clip and the map equality, `ts >= started_at ORDER BY ts LIMIT 1` can return the last
-- sample of the PREVIOUS match. `cap` comes from the same sample as ccu_start, because an
-- unbounded forward scan reads max_players from whenever sampling resumed after an outage.
-- The ctid tiebreaker matters: samples has an index on (server_id, ts) but no unique key.
edge AS (
  SELECT m.*, a.player_count AS ccu_start, a.max_players AS cap, b.player_count AS ccu_10
    FROM m, p
    LEFT JOIN LATERAL (
         SELECT s.player_count, s.max_players FROM samples s
          WHERE s.server_id = m.server_id AND s.ok AND s.player_count IS NOT NULL
            AND s.ts >= m.started_at
            AND s.ts <  LEAST(m.ended_at, m.started_at + p.grab)
            AND s.map IS NOT DISTINCT FROM m.map
          ORDER BY s.ts, s.ctid LIMIT 1) a ON TRUE
    LEFT JOIN LATERAL (
         SELECT s.player_count FROM samples s
          WHERE s.server_id = m.server_id AND s.ok AND s.player_count IS NOT NULL
            AND s.ts >= m.started_at + p.horizon
            AND s.ts <  LEAST(m.ended_at, m.started_at + p.horizon + p.grab)
            AND s.map IS NOT DISTINCT FROM m.map
          ORDER BY s.ts, s.ctid LIMIT 1) b ON TRUE
),
-- EXTRACT on a timestamptz silently reads the session TimeZone, which nothing in this codebase
-- sets, so psql on a laptop and the container would bucket the same row differently. Always
-- AT TIME ZONE an explicit value. 48 buckets (weekend flag x hour), not 168: over 30 days, 168
-- leaves many buckets holding one match, and a bucket of one has a residual of exactly zero by
-- construction, which dilutes the signal and tightens the error bars at the same time.
--
-- cap > 0 is not paranoia: the poller coerces a missing players.max to 0, so on an RCON build
-- that omits it `ccu_start < cap * headroom` is false for every row and the whole query returns
-- nothing, with no error.
d0 AS (
  SELECT e.id, e.map, e.started_at, e.ccu_start,
         (e.ccu_10 - e.ccu_start)::numeric AS delta,
         (EXTRACT(ISODOW FROM (e.started_at AT TIME ZONE p.tz)) >= 6)::int * 24
           + EXTRACT(HOUR FROM (e.started_at AT TIME ZONE p.tz))::int AS slot,
         (e.started_at AT TIME ZONE p.tz)::date AS day
    FROM edge e, p
   WHERE e.ccu_start IS NOT NULL AND e.ccu_10 IS NOT NULL
     AND e.cap IS NOT NULL AND e.cap > 0
     AND e.ccu_start::numeric < e.cap * p.headroom
),
-- Control for starting population, as a deviation from the slot's own norm. Rotation is
-- ordered, so each map has a fixed predecessor and a systematically different starting
-- population; population mean-reverts toward its time-of-day norm, so a map that always follows
-- a popular map bleeds through reversion alone. ccu_start is measured before the map's ten
-- minutes elapse, so conditioning on it is legitimate. ccu_10 is the outcome; never condition
-- on that.
sc AS (SELECT slot, AVG(ccu_start)::numeric AS slot_ccu FROM d0 GROUP BY slot),
dx AS (SELECT d0.*, (d0.ccu_start - sc.slot_ccu) AS excess FROM d0 JOIN sc USING (slot)),
sl AS (SELECT COALESCE(regr_slope(delta, excess), 0)::numeric AS g FROM dx),
d  AS (SELECT dx.id, dx.map, dx.slot, dx.day, dx.delta - sl.g * dx.excess AS y FROM dx, sl),

-- Two-way additive fit, y = mu + slot effect + map effect, by back-fitting. A single pass of
-- per-slot averaging would BE the self-baseline this whole query exists to avoid: a slot mean
-- taken over the same rows being scored is pulled toward whichever map dominates that slot, by
-- exactly (1 - n_map,slot / n_slot). On a rotation where one map holds half the entries that is
-- enough to report the second-worst map in the rotation as above average.
gm AS (SELECT AVG(y) AS mu FROM d),
b0 AS (SELECT map, AVG(y) - (SELECT mu FROM gm) AS b FROM d GROUP BY map),
a1 AS (SELECT d.slot, AVG(d.y - b0.b) - (SELECT mu FROM gm) AS a FROM d JOIN b0 USING (map) GROUP BY d.slot),
b1 AS (SELECT d.map,  AVG(d.y - a1.a) - (SELECT mu FROM gm) AS b FROM d JOIN a1 USING (slot) GROUP BY d.map),
a2 AS (SELECT d.slot, AVG(d.y - b1.b) - (SELECT mu FROM gm) AS a FROM d JOIN b1 USING (map) GROUP BY d.slot),
b2 AS (SELECT d.map,  AVG(d.y - a2.a) - (SELECT mu FROM gm) AS b FROM d JOIN a2 USING (slot) GROUP BY d.map),
a3 AS (SELECT d.slot, AVG(d.y - b2.b) - (SELECT mu FROM gm) AS a FROM d JOIN b2 USING (map) GROUP BY d.slot),
b3 AS (SELECT d.map,  AVG(d.y - a3.a) - (SELECT mu FROM gm) AS b FROM d JOIN a3 USING (slot) GROUP BY d.map),

-- The zero point is the unweighted average of the SCOREABLE maps. Unweighted, so rotation share
-- cannot move it -- which matters because the point of the number is to then edit the rotation.
-- Scoreable only, so a map that ran twelve times cannot re-baseline the maps that ran three
-- hundred; sub-threshold matches stay in the fit above, where their slot information is useful.
cnt AS (SELECT map, COUNT(*)::numeric AS n FROM d GROUP BY map),
ctr AS (
  SELECT COALESCE(
           (SELECT AVG(b3.b) FROM b3 JOIN cnt USING (map), p WHERE cnt.n >= p.min_matches),
           (SELECT AVG(b) FROM b3)
         ) AS c
),
r AS (
  SELECT d.id, d.map, d.day,
         (d.y - a3.a - (SELECT mu FROM gm)) - (SELECT c FROM ctr) AS resid
    FROM d JOIN a3 USING (slot)
),
agg AS (SELECT map, COUNT(*)::numeric AS n, AVG(resid) AS residual FROM r GROUP BY map),

-- CR1 cluster-robust standard error, clustered by day: consecutive matches share a population
-- wave and largely the same players, so treating each match as independent overstates precision.
cl  AS (SELECT r.map, r.day, SUM(r.resid - a.residual) AS c FROM r JOIN agg a USING (map) GROUP BY r.map, r.day),
cse AS (SELECT map, SUM(c * c) AS ss, COUNT(*)::numeric AS g FROM cl GROUP BY map),

-- A 30-day window gives about 30 day-clusters, and the usual 1.96 assumes infinitely many.
-- Measured on synthetic rotations, a normal critical value rejected 9-13% of random half-splits
-- of an IDENTICAL map against a nominal 5%. t(G-1) brings it back to nominal.
tq(df, t) AS (VALUES
  (1,12.706),(2,4.303),(3,3.182),(4,2.776),(5,2.571),(6,2.447),(7,2.365),(8,2.306),(9,2.262),
  (10,2.228),(11,2.201),(12,2.179),(13,2.160),(14,2.145),(15,2.131),(16,2.120),(17,2.110),
  (18,2.101),(19,2.093),(20,2.086),(21,2.080),(22,2.074),(23,2.069),(24,2.064),(25,2.060),
  (26,2.056),(27,2.052),(28,2.048),(29,2.045),(30,2.042)
),
se AS (
  SELECT cse.map,
         sqrt(cse.ss * cse.g / GREATEST(cse.g - 1, 1)) / agg.n AS se,
         COALESCE(
           (SELECT t FROM tq WHERE df = (cse.g - 1)::int),
           -- Cornish-Fisher beyond the table; within 0.0001 of the true quantile for df > 30.
           1.959963985
             + (1.959963985 ^ 3 + 1.959963985) / (4 * (cse.g - 1))
             + (5 * 1.959963985 ^ 5 + 16 * 1.959963985 ^ 3 + 3 * 1.959963985)
               / (96 * (cse.g - 1) * (cse.g - 1))
         )::numeric AS tcrit
    FROM cse JOIN agg USING (map)
)
-- The threshold is a CASE in the projection, not a HAVING: a map below it must still show its
-- count, or the panel cannot tell "too little data" from "not in the rotation".
SELECT a.map,
       a.n::int AS matches,
       CASE WHEN a.n >= p.min_matches THEN round(a.residual, 2) END AS residual,
       CASE WHEN a.n >= p.min_matches THEN round(se.se, 2) END AS se,
       CASE WHEN a.n >= p.min_matches THEN round(a.residual - se.tcrit * se.se, 2) END AS lo95,
       CASE WHEN a.n >= p.min_matches THEN round(a.residual + se.tcrit * se.se, 2) END AS hi95
  FROM agg a JOIN se USING (map), p
 ORDER BY (a.n >= p.min_matches) DESC, a.residual NULLS LAST;

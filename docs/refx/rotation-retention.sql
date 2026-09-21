-- Rotation retention, as SQL.
--
-- A SECOND implementation of what src/lib/server/rotation-retention.ts computes, so the panel's
-- numbers can be reproduced by hand -- one of the build brief's acceptance criteria for Phase 5.
-- The panel does the statistics in TypeScript so they can be unit-tested (no test in this
-- repository can reach Postgres); this does the same arithmetic in the database.
--
--   psql "$DATABASE_URL" -v server="'<server-uuid>'" -f docs/refx/rotation-retention.sql
--
-- WHAT AGREEMENT BETWEEN THESE TWO DOES AND DOES NOT PROVE. It proves the data extraction and
-- the arithmetic: the LATERAL joins, the slot bucketing, the exclusions, the aggregation. It
-- proves NOTHING about whether the estimator is the right one, because the same algorithm was
-- written twice. That is not hypothetical -- an earlier version of both stopped the fit after
-- three passes, and the two agreed perfectly on an answer that was out by 0.8 players. What
-- catches that is rotation-retention.test.ts, which scores fixtures whose truth is known.
--
-- Read docs/refx/rotation-retention.md for what the number means and what it does not.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- ---------------------------------------------------------------------------------------------
-- 1. Eligible matches, with both population readings pinned to the match they belong to.
-- ---------------------------------------------------------------------------------------------
-- Every clause is load-bearing:
--  * ended_at IS NOT NULL -- a live match has no ten-minute mark, and prune() deletes on
--    `ended_at < cutoff`, which NULL never satisfies, so matches abandoned by a poller that
--    never restarted would otherwise accumulate for ever and keep qualifying.
--  * duration >= horizon + grab -- the whole read window must lie inside the match. Filtering on
--    the horizon alone leaves a hole: a failed poll near the ten-minute mark pushes the second
--    reading past a short match's end and into the next map.
--  * LEAST(ended_at, ...) and s.map IS NOT DISTINCT FROM m.map -- started_at is back-derived as
--    (ts - matchSeconds), so it can precede the sample that first saw the match. Without both,
--    `ts >= started_at ORDER BY ts LIMIT 1` can return the last sample of the PREVIOUS match.
--  * cap from the SAME sample as ccu_start -- an unbounded forward scan reads max_players from
--    whenever sampling resumed after an outage.
--  * ORDER BY s.ts, s.ctid -- samples is indexed on (server_id, ts) but has no unique key.
--  * AT TIME ZONE 'UTC' -- EXTRACT on a timestamptz silently reads the session TimeZone, which
--    nothing in this codebase sets, so a laptop and the container would bucket rows differently.
--  * cap > 0 -- the poller coerces a missing players.max to 0, so on an RCON build that omits it
--    the headroom filter would drop every match on the server and return nothing, with no error.
DROP TABLE IF EXISTS rr_d;
CREATE TEMP TABLE rr_d AS
WITH p AS (
  SELECT :server::text AS server_id, interval '30 days' AS win, 'UTC'::text AS tz,
         0.90::numeric AS headroom, interval '10 minutes' AS horizon, interval '2 minutes' AS grab
),
m AS (
  SELECT mt.id, mt.server_id, mt.map, mt.started_at, mt.ended_at
    FROM matches mt, p
   WHERE mt.server_id = p.server_id
     AND mt.map IS NOT NULL AND mt.map <> ''
     AND mt.started_at >= now() - p.win
     AND mt.ended_at IS NOT NULL
     AND mt.ended_at >= mt.started_at + p.horizon + p.grab
),
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
d0 AS (
  SELECT e.id, e.map, e.ccu_start, (e.ccu_10 - e.ccu_start)::numeric AS delta,
         (EXTRACT(ISODOW FROM (e.started_at AT TIME ZONE p.tz)) >= 6)::int * 24
           + EXTRACT(HOUR FROM (e.started_at AT TIME ZONE p.tz))::int AS slot,
         (e.started_at AT TIME ZONE p.tz)::date AS day
    FROM edge e, p
   WHERE e.ccu_start IS NOT NULL AND e.ccu_10 IS NOT NULL
     AND e.cap IS NOT NULL AND e.cap > 0
     AND e.ccu_start::numeric < e.cap * p.headroom
),
-- Control for starting population as a deviation from the slot's own norm. Rotation is ordered,
-- so each map has a fixed predecessor and a systematically different start; population reverts
-- toward its time-of-day norm, so a map that always follows a popular one bleeds through
-- reversion alone. ccu_start is measured before the map's ten minutes elapse, so conditioning on
-- it is legitimate. ccu_10 is the outcome; never condition on that.
-- The slope itself is NOT fitted here. See section 2: fitting it before the map effects lets it
-- absorb them, because a map that always follows the popular map always starts high.
sc AS (SELECT slot, AVG(ccu_start)::numeric AS slot_ccu FROM d0 GROUP BY slot),
dx AS (SELECT d0.*, (d0.ccu_start - sc.slot_ccu) AS excess FROM d0 JOIN sc USING (slot))
SELECT dx.id, dx.map, dx.slot, dx.day, dx.delta, dx.excess
  FROM dx;

CREATE INDEX ON rr_d (map);
CREATE INDEX ON rr_d (slot);

-- ---------------------------------------------------------------------------------------------
-- 2. Two-way additive fit, y = mu + slot effect + map effect, by alternating least squares.
-- ---------------------------------------------------------------------------------------------
-- delta = mu + slot + map + g * excess, with ALL THREE blocks alternating.
--
-- The slope is one of the blocks, not a pre-step. Fitting it first, on raw delta, is the obvious
-- arrangement and it is wrong: rotation is ordered, so a map that always follows the popular map
-- always starts high, which makes `excess` collinear with map identity and lets the slope absorb
-- the map's own effect. Measured on a fixture where one map both started high and truly shed 2.5
-- players: -2.49 with no head start, -0.44 with a moderate one, -0.09 with a strong one. An 82%
-- attenuation saying "this map is fine" about the worst map in the rotation.
--
-- ITERATED TO CONVERGENCE, not a fixed number of passes. On an unbalanced design -- which every
-- real rotation is, because maps do not appear evenly across the clock -- three passes leaves a
-- large part of the slot effect still charged to the maps. Measured on a fixture with known
-- truth, three passes reported +1.30 for a map whose true effect was +0.50. It settles near 40.
DROP TABLE IF EXISTS rr_alpha;
DROP TABLE IF EXISTS rr_beta;
CREATE TEMP TABLE rr_alpha (slot int PRIMARY KEY, a numeric);
CREATE TEMP TABLE rr_beta (map text PRIMARY KEY, b numeric);

DROP TABLE IF EXISTS rr_g;
CREATE TEMP TABLE rr_g (g numeric);

DO $$
DECLARE
  mu numeric;
  g numeric := 0;
  g_new numeric;
  moved numeric;
  i int := 0;
BEGIN
  SELECT AVG(delta) INTO mu FROM rr_d;
  INSERT INTO rr_beta SELECT map, 0::numeric FROM rr_d GROUP BY map;

  LOOP
    i := i + 1;

    CREATE TEMP TABLE rr_alpha_new AS
      SELECT d.slot, AVG(d.delta - mu - COALESCE(b.b, 0) - g * d.excess) AS a
        FROM rr_d d LEFT JOIN rr_beta b USING (map) GROUP BY d.slot;

    CREATE TEMP TABLE rr_beta_new AS
      SELECT d.map, AVG(d.delta - mu - COALESCE(a.a, 0) - g * d.excess) AS b
        FROM rr_d d LEFT JOIN rr_alpha_new a USING (slot) GROUP BY d.map;

    SELECT COALESCE(regr_slope(d.delta - mu - COALESCE(a.a, 0) - COALESCE(b.b, 0), d.excess), 0)
      INTO g_new
      FROM rr_d d
      LEFT JOIN rr_alpha_new a USING (slot)
      LEFT JOIN rr_beta_new b USING (map);

    SELECT GREATEST(
             ABS(g_new - g),
             COALESCE((SELECT MAX(ABS(n.a - COALESCE(o.a, 0))) FROM rr_alpha_new n
                         LEFT JOIN rr_alpha o USING (slot)), 0),
             COALESCE((SELECT MAX(ABS(n.b - COALESCE(o.b, 0))) FROM rr_beta_new n
                         LEFT JOIN rr_beta o USING (map)), 0))
      INTO moved;

    DELETE FROM rr_alpha;
    INSERT INTO rr_alpha SELECT slot, a FROM rr_alpha_new;
    DELETE FROM rr_beta;
    INSERT INTO rr_beta SELECT map, b FROM rr_beta_new;
    DROP TABLE rr_alpha_new;
    DROP TABLE rr_beta_new;
    g := g_new;

    EXIT WHEN moved < 1e-9 OR i >= 500;
  END LOOP;

  DELETE FROM rr_g;
  INSERT INTO rr_g VALUES (g);

  IF i >= 500 THEN
    RAISE WARNING 'rotation-retention: fit hit the 500-pass cap without settling (moved=%)', moved;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Which maps can be compared at all.
-- ---------------------------------------------------------------------------------------------
-- The fit identifies a map only RELATIVE to maps it shares time slots with, directly or
-- transitively. A map that only ever runs at 04:00, alone, has its own effect and the
-- time-of-day effect perfectly confounded: the fit can put all of it in either, and does.
-- Measured on a fixture, such a map came out at exactly 0.00 against a true effect of +0.50.
-- So: connected components of the bipartite map/slot graph; only the component holding the most
-- matches is comparable.
DROP TABLE IF EXISTS rr_comp;
CREATE TEMP TABLE rr_comp AS
WITH RECURSIVE edges(a, b) AS (
  SELECT DISTINCT 'm:' || map, 's:' || slot::text FROM rr_d
  UNION
  SELECT DISTINCT 's:' || slot::text, 'm:' || map FROM rr_d
),
seeds(node, root) AS (
  SELECT DISTINCT 'm:' || map, 'm:' || map FROM rr_d
),
reach(root, node) AS (
  SELECT root, node FROM seeds
  UNION
  SELECT r.root, e.b FROM reach r JOIN edges e ON e.a = r.node
)
-- A component is identified by the smallest node label reachable from it, which is stable.
SELECT node AS member, MIN(root) AS component FROM reach GROUP BY node;

-- ---------------------------------------------------------------------------------------------
-- 4. Residuals, day-clustered standard errors, and the reasons a number is withheld.
-- ---------------------------------------------------------------------------------------------
WITH p AS (SELECT 20::int AS min_matches),
mu AS (SELECT AVG(delta) AS mu FROM rr_d),
r AS (
  SELECT d.id, d.map, d.day,
         d.delta - (SELECT g FROM rr_g) * d.excess - COALESCE(a.a, 0) - (SELECT mu FROM mu) AS raw
    FROM rr_d d LEFT JOIN rr_alpha a USING (slot)
),
cnt AS (SELECT map, COUNT(*)::numeric AS n FROM rr_d GROUP BY map),
main AS (
  SELECT c.component
    FROM rr_comp c JOIN rr_d d ON ('m:' || d.map) = c.member
   GROUP BY c.component ORDER BY COUNT(*) DESC LIMIT 1
),
comparable AS (
  SELECT substring(c.member from 3) AS map
    FROM rr_comp c, main, cnt, p
   WHERE c.member LIKE 'm:%' AND c.component = main.component
     AND cnt.map = substring(c.member from 3) AND cnt.n >= p.min_matches
),
-- The zero point is the unweighted average of the COMPARABLE maps: unweighted so rotation share
-- cannot move it, comparable-only so a map nobody can act on does not re-baseline the rest.
ctr AS (
  SELECT COALESCE((SELECT AVG(b.b) FROM rr_beta b JOIN comparable USING (map)),
                  (SELECT AVG(b) FROM rr_beta)) AS c
),
res AS (SELECT r.id, r.map, r.day, r.raw - (SELECT c FROM ctr) AS resid FROM r),
agg AS (SELECT map, COUNT(*)::numeric AS n, AVG(resid) AS residual FROM res GROUP BY map),
-- CR1 cluster-robust standard error, clustered by day: consecutive matches share a population
-- wave and largely the same players, so treating each match as independent overstates precision.
cl  AS (SELECT res.map, res.day, SUM(res.resid - a.residual) AS c
          FROM res JOIN agg a USING (map) GROUP BY res.map, res.day),
cse AS (SELECT map, SUM(c * c) AS ss, COUNT(*)::numeric AS g FROM cl GROUP BY map),
-- A 30-day window is about 30 day-clusters, and 1.96 assumes infinitely many. Measured over 200
-- random half-splits of one map, a normal critical value rejected 9-13% against a nominal 5%.
tq(df, t) AS (VALUES
  (1,12.706),(2,4.303),(3,3.182),(4,2.776),(5,2.571),(6,2.447),(7,2.365),(8,2.306),(9,2.262),
  (10,2.228),(11,2.201),(12,2.179),(13,2.160),(14,2.145),(15,2.131),(16,2.120),(17,2.110),
  (18,2.101),(19,2.093),(20,2.086),(21,2.080),(22,2.074),(23,2.069),(24,2.064),(25,2.060),
  (26,2.056),(27,2.052),(28,2.048),(29,2.045),(30,2.042)
),
se AS (
  SELECT cse.map,
         CASE WHEN cse.g >= 2 THEN sqrt(cse.ss * cse.g / (cse.g - 1)) / agg.n END AS se,
         COALESCE((SELECT t FROM tq WHERE df = (cse.g - 1)::int),
                  1.959963985 + (1.959963985 ^ 3 + 1.959963985) / (4 * GREATEST(cse.g - 1, 1))
                    + (5 * 1.959963985 ^ 5 + 16 * 1.959963985 ^ 3 + 3 * 1.959963985)
                      / (96 * GREATEST(cse.g - 1, 1) ^ 2))::numeric AS tcrit
    FROM cse JOIN agg USING (map)
),
withheld AS (
  SELECT a.map,
         CASE
           WHEN a.n < p.min_matches THEN 'too-few-matches'
           WHEN NOT EXISTS (SELECT 1 FROM comparable c WHERE c.map = a.map) THEN 'not-comparable'
           WHEN (SELECT COUNT(*) FROM comparable) < 2 THEN 'nothing-to-compare-with'
         END AS why
    FROM agg a, p
)
SELECT a.map,
       a.n::int AS matches,
       w.why AS withheld,
       CASE WHEN w.why IS NULL THEN round(a.residual, 2) END AS residual,
       -- se is NULL when NOT ESTIMABLE, which is not the same as small: one day-cluster, or no
       -- observed spread at all. Reporting 0 would claim infinite precision from one evening.
       CASE WHEN w.why IS NULL AND se.se > 0 THEN round(se.se, 2) END AS se,
       CASE WHEN w.why IS NULL AND se.se > 0 THEN round(a.residual - se.tcrit * se.se, 2) END AS lo95,
       CASE WHEN w.why IS NULL AND se.se > 0 THEN round(a.residual + se.tcrit * se.se, 2) END AS hi95
  FROM agg a JOIN se USING (map) JOIN withheld w USING (map), p
-- Scored maps worst first; withheld maps after them, most-played first -- the same order the
-- panel uses, so the two listings can be compared line by line.
 ORDER BY (w.why IS NULL) DESC,
          CASE WHEN w.why IS NULL THEN a.residual END ASC,
          a.n DESC;

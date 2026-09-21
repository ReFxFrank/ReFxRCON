-- D8: sample retention 90 -> 120 days.
--
-- The analytics panels offer a 90-day window (rotation retention, leaderboards, public stats).
-- At 90-day retention the far end of that window is always being pruned out from under it, so
-- a "90 days" reading was quietly short of 90 days. 120 gives the window a month of margin.
--
-- Cost, measured: 240 bytes per sample row including indexes. At POLL_SECONDS=20 and four
-- servers that is 17,280 rows/day, so the extra 30 days is about 125 MB.
--
-- The poller's own pruning is driven by SAMPLE_RETENTION_DAYS in src/lib/server/poller.ts, which
-- must match this. On plain Postgres that constant is the ONLY thing pruning samples.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
		-- add_retention_policy(..., if_not_exists => TRUE) does NOT update an existing policy --
		-- it sees one and returns. The old 90-day policy has to be removed first.
		PERFORM remove_retention_policy('samples', if_exists => TRUE);
		PERFORM add_retention_policy('samples', INTERVAL '120 days', if_not_exists => TRUE);
	ELSE
		RAISE NOTICE 'timescaledb not installed: samples pruning stays with the poller';
	END IF;
END $$;

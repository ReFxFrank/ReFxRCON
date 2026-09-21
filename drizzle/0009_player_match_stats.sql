CREATE TABLE "player_match_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"match_id" bigint NOT NULL,
	"server_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"name" text NOT NULL,
	"faction" text,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"cash" integer DEFAULT 0 NOT NULL,
	"result" text
);
--> statement-breakpoint
ALTER TABLE "player_sessions" ADD COLUMN "raw_kills" integer;--> statement-breakpoint
ALTER TABLE "player_sessions" ADD COLUMN "raw_deaths" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "player_match_stats_match_steam_idx" ON "player_match_stats" USING btree ("match_id","steam_id");--> statement-breakpoint
CREATE INDEX "player_match_stats_steam_idx" ON "player_match_stats" USING btree ("steam_id","last_seen");--> statement-breakpoint
CREATE INDEX "player_match_stats_server_idx" ON "player_match_stats" USING btree ("server_id","last_seen");
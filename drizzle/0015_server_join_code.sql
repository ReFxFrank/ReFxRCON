-- WARDOGS joins by code through its own browser, never by address: the game address becomes a join code.
ALTER TABLE "servers" DROP COLUMN "join_address";--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "join_code" text DEFAULT '' NOT NULL;

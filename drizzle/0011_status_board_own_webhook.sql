-- Boards get their own channel webhook instead of borrowing a mirror webhook. Boards made
-- before this (none in any known deployment) cannot carry over: they had no URL of their own.
DELETE FROM "status_boards";--> statement-breakpoint
ALTER TABLE "status_boards" DROP CONSTRAINT "status_boards_webhook_id_webhooks_id_fk";
--> statement-breakpoint
ALTER TABLE "status_boards" DROP COLUMN "webhook_id";--> statement-breakpoint
ALTER TABLE "status_boards" ADD COLUMN "url_enc" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "status_boards" ALTER COLUMN "url_enc" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "status_boards" ADD COLUMN "url_hint" text DEFAULT '' NOT NULL;

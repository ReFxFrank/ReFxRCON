ALTER TABLE "organizations" ADD COLUMN "allow_stats" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "allow_public_status" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "allow_public_stats" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "stats_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "public_status" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "public_stats" boolean DEFAULT false NOT NULL;
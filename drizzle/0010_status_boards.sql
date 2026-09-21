CREATE TABLE "status_boards" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"server_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"top_players" integer DEFAULT 10 NOT NULL,
	"message_id" text,
	"last_updated_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_boards" ADD CONSTRAINT "status_boards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_boards" ADD CONSTRAINT "status_boards_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_boards" ADD CONSTRAINT "status_boards_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_boards_server_idx" ON "status_boards" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "status_boards_org_idx" ON "status_boards" USING btree ("org_id");
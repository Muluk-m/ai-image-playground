CREATE TABLE "operator_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_operator_audits_target" ON "operator_audits" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_operator_audits_created_at" ON "operator_audits" USING btree ("created_at" DESC NULLS LAST);
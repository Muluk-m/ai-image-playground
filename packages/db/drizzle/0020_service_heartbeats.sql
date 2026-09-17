CREATE TABLE "service_heartbeats" (
	"service" text NOT NULL,
	"instance" text NOT NULL,
	"version" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"detail" jsonb,
	CONSTRAINT "service_heartbeats_service_instance_pk" PRIMARY KEY("service","instance")
);
--> statement-breakpoint
CREATE INDEX "idx_service_heartbeats_seen" ON "service_heartbeats" USING btree ("service","last_seen_at" DESC NULLS LAST);
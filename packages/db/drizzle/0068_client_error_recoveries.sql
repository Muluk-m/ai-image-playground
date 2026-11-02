CREATE TABLE "client_error_recoveries" (
  "id" text PRIMARY KEY NOT NULL,
  "incident_id" text NOT NULL,
  "operation" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "device_id" text NOT NULL,
  "user_id" text
);
--> statement-breakpoint
CREATE INDEX "idx_client_error_recoveries_incident" ON "client_error_recoveries" ("incident_id", "device_id");
--> statement-breakpoint
CREATE INDEX "idx_client_error_recoveries_received" ON "client_error_recoveries" ("received_at");

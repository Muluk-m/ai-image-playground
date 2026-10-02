CREATE TABLE "client_errors" (
  "id" text PRIMARY KEY NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "kind" text NOT NULL,
  "fingerprint" text NOT NULL,
  "name" text,
  "message" text NOT NULL,
  "stack" text,
  "url" text,
  "release" text,
  "device_id" text,
  "user_id" text,
  "user_agent" text,
  "context" jsonb,
  CONSTRAINT "client_errors_kind_check" CHECK ("kind" IN ('boot', 'error', 'rejection', 'react'))
);
--> statement-breakpoint
CREATE INDEX "idx_client_errors_received" ON "client_errors" USING btree ("received_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_client_errors_fingerprint" ON "client_errors" USING btree ("fingerprint", "received_at" DESC);

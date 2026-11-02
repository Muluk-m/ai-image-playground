CREATE TABLE "operator_config_overrides" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "baseline_value" jsonb NOT NULL,
  "operator_id" text NOT NULL,
  "reason" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "operator_config_overrides_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "operator_config_overrides_reason_check" CHECK (char_length(btrim("reason")) > 0)
);
CREATE TABLE "operator_config_state" (
  "id" integer PRIMARY KEY NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL
);
INSERT INTO "operator_config_state" ("id", "revision") VALUES (1, 0);

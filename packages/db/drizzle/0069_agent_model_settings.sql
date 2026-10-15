CREATE TABLE "agent_model_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "revision" integer NOT NULL,
  "settings" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

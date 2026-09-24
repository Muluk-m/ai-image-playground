CREATE TABLE "admin_user_notes" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "note" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

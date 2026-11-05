CREATE TABLE "upstream_api_secrets" (
  "id" text PRIMARY KEY NOT NULL,
  "nonce" text NOT NULL,
  "tag" text NOT NULL,
  "ciphertext" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "updated_by" text NOT NULL
);

CREATE TABLE "domain_migrations" (
 "id" text PRIMARY KEY NOT NULL,
 "proof_hash" text NOT NULL,
 "upload_hash" text NOT NULL,
 "source_session_hash" text,
 "source_user_id" text,
 "created_at" timestamp with time zone NOT NULL,
 "expires_at" timestamp with time zone NOT NULL,
 "chunks" integer DEFAULT 0 NOT NULL,
 "bytes" integer DEFAULT 0 NOT NULL,
 "sealed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_migration_chunks" (
 "migration_id" text NOT NULL REFERENCES "domain_migrations"("id") ON DELETE CASCADE,
 "sequence" integer NOT NULL,
 "ciphertext" text NOT NULL,
 PRIMARY KEY("migration_id", "sequence")
);

CREATE TABLE "domain_migration_chunks" (
	"migration_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"ciphertext" text NOT NULL,
	CONSTRAINT "domain_migration_chunks_migration_id_sequence_pk" PRIMARY KEY("migration_id","sequence")
);
--> statement-breakpoint
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
ALTER TABLE "domain_migration_chunks" ADD CONSTRAINT "domain_migration_chunks_migration_id_domain_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."domain_migrations"("id") ON DELETE cascade ON UPDATE no action;
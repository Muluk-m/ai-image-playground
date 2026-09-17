CREATE TABLE media_objects (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 sha256 text NOT NULL,
 bytes bigint NOT NULL CHECK (bytes > 0),
 content_type text NOT NULL,
 status text NOT NULL CHECK (status IN ('pending', 'ready')),
 reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
 staging_key text NOT NULL,
 object_key text,
 preview_key text,
 preview_bytes bigint NOT NULL DEFAULT 0,
 width integer,
 height integer,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_media_objects_owner_hash ON media_objects(user_id, sha256);
--> statement-breakpoint
CREATE INDEX idx_media_objects_pending ON media_objects(status, expires_at);
--> statement-breakpoint
CREATE TABLE media_references (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 media_id text NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
 owner_kind text NOT NULL CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation')),
 owner_id text NOT NULL,
 created_at timestamptz NOT NULL,
 CONSTRAINT media_references_user_id_owner_kind_owner_id_media_id_pk PRIMARY KEY(user_id, owner_kind, owner_id, media_id)
);
--> statement-breakpoint
CREATE INDEX idx_media_references_media ON media_references(media_id);

--> statement-breakpoint
ALTER TABLE canvas_projects ADD COLUMN cover_media_id text;

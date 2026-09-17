CREATE TABLE generation_images (
 generation_id text NOT NULL REFERENCES generation_records(id) ON DELETE CASCADE,
 role text NOT NULL CHECK (role IN ('input', 'mask', 'output')),
 position integer NOT NULL,
 media_id text NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
 CONSTRAINT generation_images_generation_id_role_position_pk PRIMARY KEY (generation_id, role, position)
);

ALTER TABLE tasks ADD COLUMN archive_payload jsonb;
ALTER TABLE generation_records ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN actual_parameters jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE generation_records ADD COLUMN archive_status text NOT NULL DEFAULT 'none' CHECK (archive_status IN ('none', 'pending', 'ready', 'unavailable')), ADD COLUMN error_type text;

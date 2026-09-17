ALTER TABLE generation_records DROP COLUMN parameters, DROP COLUMN actual_parameters, DROP COLUMN archive_status, DROP COLUMN error_type;
ALTER TABLE tasks DROP COLUMN archive_payload;
DROP TABLE generation_images;

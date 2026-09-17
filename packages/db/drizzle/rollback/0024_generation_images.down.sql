ALTER TABLE generation_records DROP COLUMN parameters, DROP COLUMN actual_parameters;
ALTER TABLE tasks DROP COLUMN archive_payload;
DROP TABLE generation_images;

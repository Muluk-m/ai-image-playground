-- Keep the nullable metering column: older releases ignore it and dropping it
-- would lose immutable billing decisions for accepted tasks.
SELECT 1;

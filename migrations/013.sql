ALTER TABLE devices ADD COLUMN digital_count integer NOT NULL DEFAULT 1000 CHECK (digital_count BETWEEN 0 AND 1000);

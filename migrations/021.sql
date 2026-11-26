-- A restored issuing actor must never repeat a number issued after the restored snapshot.
ALTER TABLE devices ADD COLUMN online_number_floor bigint NOT NULL DEFAULT 0 CHECK (online_number_floor >= 0);

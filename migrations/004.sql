ALTER TABLE devices ADD COLUMN donor_access boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN last_seen timestamptz NOT NULL DEFAULT now();
CREATE TABLE backup_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, completed_at timestamptz DEFAULT now(), digest text NOT NULL
);


CREATE TABLE fiscal_years (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    starts date NOT NULL,
    ends date NOT NULL CHECK (ends >= starts),
    EXCLUDE USING gist (daterange(starts, ends, '[]') WITH &&)
);
CREATE UNIQUE INDEX fiscal_years_name ON fiscal_years (lower(btrim(name)));

-- Existing workspaces keep their IDs, records and access grants until assigned.
ALTER TABLE events ADD COLUMN fiscal_year uuid REFERENCES fiscal_years;
CREATE INDEX events_fiscal_year ON events (fiscal_year);

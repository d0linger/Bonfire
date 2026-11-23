CREATE TABLE period_closures (
 id uuid PRIMARY KEY, period_id text NOT NULL, version int NOT NULL,
 starts date NOT NULL, ends date NOT NULL, reviewer text NOT NULL REFERENCES users,
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 reopened_by text REFERENCES users, reopened_reason text, reopened_at timestamptz,
 UNIQUE(period_id,version), CHECK(ends >= starts)
);
CREATE INDEX entries_kind ON entries(event,kind);
CREATE INDEX open_conflicts ON operations(event) WHERE outcome='Konflikt';
CREATE INDEX devices_event ON devices(event);
CREATE TABLE directory (
 id text PRIMARY KEY, revision bigint NOT NULL, data jsonb NOT NULL, device uuid NOT NULL REFERENCES devices
);
INSERT INTO directory SELECT DISTINCT ON(id) id,revision,data,device FROM entries WHERE kind='contact' ORDER BY id,revision DESC;


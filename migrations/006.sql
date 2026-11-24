CREATE TABLE print_log (
 id uuid PRIMARY KEY, event uuid NOT NULL REFERENCES events, device uuid NOT NULL REFERENCES devices,
 subject text NOT NULL, local_time timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE devices ADD COLUMN incident text;


ALTER TABLE devices ADD COLUMN incident_state text NOT NULL DEFAULT ''
    CHECK (incident_state IN ('', 'missing', 'incomplete', 'returning'));
UPDATE devices SET incident_state='missing' WHERE NOT sealed AND coalesce(incident,'')<>'';

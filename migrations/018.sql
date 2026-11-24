CREATE TABLE backup_installation (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    installation uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO backup_installation DEFAULT VALUES;

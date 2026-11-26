-- Original foreign keys and sealed audit records always refer to the same event.
-- Operational callers see only available workspaces, even when using an old URL.
ALTER TABLE events RENAME TO event_records;
ALTER TABLE event_records ADD COLUMN deleted_at timestamptz;
ALTER TABLE event_records ADD CHECK (deleted_at IS NULL OR NOT general_ledger);
CREATE VIEW events AS
    SELECT id, name, starts, ends, closed, accounts, general_ledger, fiscal_year
    FROM event_records WHERE deleted_at IS NULL
    WITH LOCAL CHECK OPTION;

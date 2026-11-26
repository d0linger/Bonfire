-- A receipt commits in the same transaction as every count or cash movement.
CREATE TABLE wallet_batch_receipts (
    request uuid PRIMARY KEY,
    event uuid NOT NULL REFERENCES event_records,
    device uuid NOT NULL REFERENCES devices,
    digest bytea NOT NULL CHECK (octet_length(digest)=32)
);

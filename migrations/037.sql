-- Corrections append revisions. One receipt can fund several independently counted wallets.
CREATE TABLE wallet_receipt_revisions (
    request uuid PRIMARY KEY,
    digest bytea NOT NULL CHECK (octet_length(digest)=32),
    event uuid NOT NULL REFERENCES event_records,
    wallet text NOT NULL,
    source_event uuid NOT NULL REFERENCES event_records,
    receipt text NOT NULL,
    source_revision bigint NOT NULL CHECK (source_revision>0),
    revision bigint NOT NULL CHECK (revision>0),
    amount bigint NOT NULL CHECK (amount BETWEEN 0 AND 999999999999),
    counted_on date NOT NULL,
    actor uuid NOT NULL REFERENCES devices,
    reason text NOT NULL,
    UNIQUE(event,wallet,source_event,receipt,revision)
);
CREATE INDEX wallet_receipt_source ON wallet_receipt_revisions(source_event,receipt);
CREATE VIEW wallet_receipt_links WITH (security_invoker=true) AS
 SELECT DISTINCT ON (event,wallet,source_event,receipt) *
 FROM wallet_receipt_revisions ORDER BY event,wallet,source_event,receipt,revision DESC;

-- Allocation rows are present for reporting and closing evidence but are not journal movements.
CREATE OR REPLACE VIEW settlement_entries WITH (security_invoker=true) AS
 SELECT event,id,revision,device,kind,
   (data-'PostingOrder'-'BalanceOrder') || jsonb_strip_nulls(jsonb_build_object(
     'PostingOrder',cash_order::text,'BalanceOrder',balance_order::text)) AS data
 FROM entries
 UNION ALL
 SELECT l.event,'wallet-link:'||l.request,l.revision,l.actor,'wallet-link',
   jsonb_build_object('Date',counted_on,'Label','Allocated cashbook receipt','Amount',l.amount,'Wallet',l.wallet,'Bar',coalesce(w.data->>'Bar',''))
 FROM wallet_receipt_links l LEFT JOIN entries w ON w.event=l.event AND w.id=l.wallet WHERE l.amount>0;

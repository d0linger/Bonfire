-- Settlement counts retain original movement order. Reconciliation also needs to
-- know when a financial entry was last corrected relative to an observed balance.
CREATE SEQUENCE balance_revision_order;
ALTER TABLE entries ADD COLUMN balance_order bigint;
WITH recorded AS (
  SELECT o.event,o.target,max(a.id) AS last_edit
  FROM operations o JOIN audit a ON a.event=o.event AND a.subject=o.id::text
  WHERE a.action='Übernommen' OR a.action LIKE 'übernehmen: %'
     OR a.action LIKE 'Storno und Ersatz · %'
  GROUP BY o.event,o.target
)
UPDATE entries e SET balance_order=r.last_edit FROM recorded r
 WHERE e.event=r.event AND e.id=r.target;
SELECT setval('balance_revision_order',coalesce(max(balance_order),0)+1,false) FROM entries;
ALTER TABLE entries ALTER COLUMN balance_order SET DEFAULT nextval('balance_revision_order');

CREATE FUNCTION mark_balance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.balance_order=nextval('balance_revision_order');
  RETURN NEW;
END;
$$;
CREATE TRIGGER mark_balance_revision BEFORE UPDATE OF revision ON entries
 FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision) EXECUTE FUNCTION mark_balance_revision();
CREATE OR REPLACE VIEW settlement_entries WITH (security_invoker=true) AS
 SELECT event,id,revision,device,kind,
   (data-'PostingOrder'-'BalanceOrder') || jsonb_strip_nulls(jsonb_build_object(
     'PostingOrder',cash_order::text,'BalanceOrder',balance_order::text)) AS data
 FROM entries;

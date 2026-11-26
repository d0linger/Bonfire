-- Same-day movements use their original posting order. A recounted closing
-- balance establishes a new cutoff. The event lock serializes these writes.
CREATE SEQUENCE cash_posting_order;
ALTER TABLE entries ADD COLUMN cash_order bigint;
WITH recorded AS (
    SELECT o.event, o.target,
           CASE WHEN o.kind='count' THEN max(a.id) ELSE min(a.id) END AS posting
    FROM operations o JOIN audit a ON a.event=o.event AND a.subject=o.id::text
    WHERE a.action='Übernommen' OR a.action LIKE 'übernehmen: %'
    GROUP BY o.event, o.target, o.kind
)
UPDATE entries e SET cash_order=r.posting
FROM recorded r WHERE e.event=r.event AND e.id=r.target;

SELECT setval('cash_posting_order', coalesce(max(cash_order),0)+1, false) FROM entries;
ALTER TABLE entries ALTER COLUMN cash_order SET DEFAULT nextval('cash_posting_order');

CREATE FUNCTION order_cash_recount() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='count' AND NEW.revision<>OLD.revision THEN
        NEW.cash_order=nextval('cash_posting_order');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER order_cash_recount BEFORE UPDATE OF revision ON entries
FOR EACH ROW EXECUTE FUNCTION order_cash_recount();

CREATE VIEW settlement_entries WITH (security_invoker=true) AS
 SELECT event,id,revision,device,kind,
        (data-'PostingOrder') || jsonb_strip_nulls(jsonb_build_object('PostingOrder',cash_order::text)) AS data
 FROM entries;

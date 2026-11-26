-- All untraced historical postings existed by this migration. Use a shared
-- upper bound for reconciliation, without inferring their order relative to
-- one another. Historical observations without evidence still need recounting.
WITH boundary AS MATERIALIZED (SELECT nextval('balance_revision_order') AS value)
UPDATE entries SET balance_order = boundary.value FROM boundary
WHERE entries.balance_order IS NULL AND entries.kind <> 'actual';

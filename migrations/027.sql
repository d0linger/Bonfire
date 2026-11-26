ALTER TABLE fiscal_years ADD COLUMN closed boolean NOT NULL DEFAULT false;

-- A prior-year opening created before this migration could leave the online
-- actor's counter behind its committed operation.
UPDATE devices d SET last_seq = o.last_seq
FROM (SELECT device, max(seq) AS last_seq FROM operations GROUP BY device) o
WHERE d.id = o.device AND d.online_actor AND d.last_seq < o.last_seq;

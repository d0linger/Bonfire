ALTER TABLE event_closures ADD COLUMN account_mode boolean;
ALTER TABLE period_closures ADD COLUMN account_mode boolean;
ALTER TABLE period_closures ADD COLUMN source_event uuid REFERENCES event_records;
UPDATE period_closures p SET source_event=a.event
FROM audit a JOIN event_records e ON e.id=a.event
WHERE a.action='Periodenabschluss' AND a.subject=p.id::text;
-- Historical counts retain the scope originally used for their balances.
UPDATE event_closures c SET account_mode=EXISTS (
 SELECT FROM jsonb_array_elements(c.snapshot) j WHERE j->>'Kind'='actual'
 AND coalesce(j->'Data'->>'Account','')<>'');
UPDATE period_closures c SET account_mode=EXISTS (
 SELECT FROM jsonb_array_elements(c.snapshot) j WHERE j->>'Kind'='actual'
 AND coalesce(j->'Data'->>'Account','')<>'');

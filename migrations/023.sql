-- Keep a permanent receipt so stale tabs and devices cannot recreate a removed entry.
CREATE TABLE entry_removals (
    event uuid NOT NULL REFERENCES event_records,
    target text NOT NULL,
    operation uuid UNIQUE NOT NULL REFERENCES operations,
    destination_operation uuid REFERENCES operations,
    PRIMARY KEY(event, target)
);

-- The runtime can append a receipt. Only its matching recorded revision may be removed.
CREATE FUNCTION apply_entry_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
    DELETE FROM entries j USING operations o
        WHERE o.id=NEW.operation AND o.outcome IN ('Eintrag entfernt','Buchung storniert','Eintrag umgebucht')
          AND j.event=NEW.event AND j.id=NEW.target AND o.event=j.event AND o.target=j.id AND o.base=j.revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Kein passender Vorgang zur Entfernung'; END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION apply_entry_removal() FROM PUBLIC;
CREATE TRIGGER entry_removal AFTER INSERT ON entry_removals FOR EACH ROW EXECUTE FUNCTION apply_entry_removal();

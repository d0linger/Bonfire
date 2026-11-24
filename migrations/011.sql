CREATE SEQUENCE price_changes;
CREATE TABLE price_history (
    event uuid NOT NULL REFERENCES events, version bigint NOT NULL, subject text NOT NULL,
    revision bigint NOT NULL, data jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event,version,subject)
);
INSERT INTO price_history(event,version,subject,revision,data)
SELECT event,0,id,revision,data FROM entries WHERE kind='price';
CREATE FUNCTION record_price_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO price_history(event,version,subject,revision,data)
    VALUES (NEW.event,nextval('price_changes'),NEW.id,NEW.revision,NEW.data);
    RETURN NEW;
END;
$$;
CREATE TRIGGER price_history_entry AFTER INSERT OR UPDATE OF data ON entries
FOR EACH ROW WHEN (NEW.kind='price') EXECUTE FUNCTION record_price_history();

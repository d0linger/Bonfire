CREATE TABLE fire_accounts (
 id uuid PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX fire_account_name ON fire_accounts(lower(btrim(name)));
CREATE TABLE fire_account_links (
 event uuid NOT NULL, local_id text NOT NULL, account uuid NOT NULL REFERENCES fire_accounts,
 PRIMARY KEY(event, local_id), FOREIGN KEY(event,local_id) REFERENCES entries(event,id)
);
CREATE TABLE fire_year_counts (
 year uuid REFERENCES fiscal_years, account uuid REFERENCES fire_accounts, opening bigint, actual bigint, revision integer NOT NULL,
 PRIMARY KEY(year,account), CHECK(opening>=0 AND actual>=0)
);
CREATE TABLE template_library (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_event uuid NOT NULL, source_name text NOT NULL, entry_id text NOT NULL,
 revision integer NOT NULL, data jsonb NOT NULL, UNIQUE(source_event, entry_id, revision)
);
INSERT INTO template_library(source_event,source_name,entry_id,revision,data)
 SELECT j.event,e.name,j.id,j.revision,j.data FROM entries j JOIN events e ON e.id=j.event WHERE j.kind='template';
CREATE FUNCTION save_template_release() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
 INSERT INTO public.template_library(source_event,source_name,entry_id,revision,data)
 SELECT NEW.event,e.name,NEW.id,NEW.revision,NEW.data FROM public.events e WHERE e.id=NEW.event;
 RETURN NEW;
 END $$;
CREATE TRIGGER template_release AFTER INSERT OR UPDATE OF data ON entries FOR EACH ROW
 WHEN (NEW.kind='template') EXECUTE FUNCTION save_template_release();

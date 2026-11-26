-- The sequence within each chain follows the order of the locked chain head.
-- Audit IDs alone can be allocated out of order by concurrent transactions.
CREATE TABLE audit_chain_heads (
    lane text PRIMARY KEY, position bigint NOT NULL DEFAULT 0,
    digest bytea NOT NULL DEFAULT ''::bytea
);
INSERT INTO audit_chain_heads(lane) VALUES ('Finanzen'), ('Betrieb');
CREATE TABLE audit_seals (
    audit_id bigint PRIMARY KEY REFERENCES audit(id),
    lane text NOT NULL REFERENCES audit_chain_heads(lane),
    position bigint NOT NULL, digest bytea NOT NULL,
    history_limit bigint NOT NULL, has_operation boolean NOT NULL,
    UNIQUE(lane,position)
);

CREATE FUNCTION audit_operation_id(subject text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN subject ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN subject::uuid END
$$;
CREATE INDEX audit_operation_history ON journal_history(event,operation,direction);
CREATE FUNCTION audit_row_hash(previous bytea, lane text, pos bigint, item audit, journal_bound bigint, with_op boolean)
RETURNS bytea LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
    SELECT sha256(previous || convert_to(jsonb_build_array(lane,pos,item.id,
        extract(epoch FROM item.at),item.event,item.username,item.action,
        item.subject,item.actor_device,journal_bound,with_op,
        (SELECT jsonb_agg(jsonb_build_array(j.id,j.revision,j.direction,j.target,j.actor,j.kind,j.data) ORDER BY j.id)
         FROM journal_history j WHERE j.operation=audit_operation_id(item.subject) AND j.event=item.event AND j.id<=journal_bound),
        (SELECT jsonb_build_array(o.device,o.seq,o.base,o.target,o.kind,encode(o.digest,'hex'),extract(epoch FROM o.local_time))
         FROM operations o WHERE with_op AND o.id=audit_operation_id(item.subject) AND o.event=item.event)
        )::text,'UTF8'))
$$;
CREATE FUNCTION seal_audit_item(item audit) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
    bucket text := CASE WHEN item.event IS NULL THEN 'Betrieb' ELSE 'Finanzen' END;
    head audit_chain_heads%ROWTYPE;
    signature bytea;
    upper_id bigint;
    with_op boolean;
BEGIN
    SELECT * INTO STRICT head FROM audit_chain_heads WHERE lane=bucket FOR UPDATE;
    SELECT coalesce(max(id),0) INTO upper_id FROM journal_history
        WHERE event=item.event AND operation=audit_operation_id(item.subject);
    SELECT EXISTS(SELECT FROM operations WHERE event=item.event AND id=audit_operation_id(item.subject)) INTO with_op;
    signature := audit_row_hash(head.digest,bucket,head.position+1,item,upper_id,with_op);
    INSERT INTO audit_seals VALUES(item.id,bucket,head.position+1,signature,upper_id,with_op);
    UPDATE audit_chain_heads SET position=head.position+1,digest=signature WHERE lane=bucket;
END
$$;
REVOKE ALL ON FUNCTION seal_audit_item(audit) FROM PUBLIC;
-- Backfill the legacy history exactly once. This is a baseline, not a retroactive attestation.
DO $$ DECLARE item audit%ROWTYPE; BEGIN
    FOR item IN SELECT * FROM audit ORDER BY id LOOP PERFORM seal_audit_item(item); END LOOP;
END $$;
CREATE FUNCTION seal_new_audit_item() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN PERFORM seal_audit_item(NEW); RETURN NEW; END
$$;
CREATE TRIGGER audit_seal AFTER INSERT ON audit FOR EACH ROW EXECUTE FUNCTION seal_new_audit_item();
CREATE INDEX audit_event_at ON audit(event,at DESC);
CREATE INDEX audit_user_at ON audit(username,at DESC);
CREATE FUNCTION audit_session_login() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.audit(username,action,subject) VALUES(NEW.username,'Anmeldung erfolgreich','Sitzung'); RETURN NEW; END
$$;
CREATE TRIGGER audit_session AFTER INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION audit_session_login();


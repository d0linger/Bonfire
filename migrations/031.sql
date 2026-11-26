-- Expired windows are removed on the next reservation. Keys are SHA-256 digests
-- scoped to a pair, source or account. No client address or login is stored here.
CREATE TABLE login_attempt_windows (
    window_start timestamptz NOT NULL,
    identity bytea NOT NULL,
    attempts integer NOT NULL CHECK (attempts >= 0),
    PRIMARY KEY (window_start, identity)
);

CREATE FUNCTION reserve_login_attempt(pair_key bytea, source_key bytea, account_key bytea)
RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
    slot timestamptz;
    pair_count integer;
    source_count integer;
    account_count integer;
BEGIN
    -- Serialize only the short counter operation; password verification runs afterwards.
    PERFORM pg_advisory_xact_lock(751031);
    slot := date_trunc('minute', clock_timestamp());
    DELETE FROM login_attempt_windows WHERE window_start < slot;
    SELECT coalesce(max(attempts) FILTER (WHERE identity=pair_key),0),
           coalesce(max(attempts) FILTER (WHERE identity=source_key),0),
           coalesce(max(attempts) FILTER (WHERE identity=account_key),0)
      INTO pair_count,source_count,account_count
      FROM login_attempt_windows
     WHERE window_start=slot AND identity IN (pair_key,source_key,account_key);
    IF source_count>=60 OR pair_count>=12 OR (account_count>=36 AND pair_count>=2) THEN
        RETURN NULL;
    END IF;
    INSERT INTO login_attempt_windows(window_start,identity,attempts)
        SELECT slot,k,1 FROM unnest(ARRAY[pair_key,source_key,account_key]) AS k
        ON CONFLICT (window_start,identity) DO UPDATE SET attempts=login_attempt_windows.attempts+1;
    RETURN slot;
END;
$$;

CREATE FUNCTION clear_login_attempt(slot timestamptz,pair_key bytea,source_key bytea,account_key bytea)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(751031);
    DELETE FROM login_attempt_windows WHERE window_start=slot AND identity=pair_key;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE login_attempt_windows SET attempts=attempts-1
      WHERE window_start=slot AND identity IN (source_key,account_key) AND attempts>0;
END;
$$;

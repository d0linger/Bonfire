-- Exercise the database functions used by password authentication. Roll back all fixtures.
BEGIN;
DO $$
DECLARE
  pair bytea := sha256('test-pair'::bytea);
  source bytea := sha256('test-source'::bytea);
  account bytea := sha256('test-account'::bytea);
  other_source bytea := sha256('other-source'::bytea);
  other_pair bytea := sha256('other-pair'::bytea);
  slot timestamptz := date_trunc('minute',clock_timestamp());
BEGIN
  IF clock_timestamp() - slot > interval '58 seconds' THEN
    PERFORM pg_sleep(2);
    slot := date_trunc('minute',clock_timestamp());
  END IF;
  FOR i IN 1..12 LOOP
    IF reserve_login_attempt(pair,source,account) IS NULL THEN RAISE EXCEPTION 'premature pair limit'; END IF;
  END LOOP;
  -- A full former in-memory cache must not remove this pair or block a fresh pair.
  INSERT INTO login_attempt_windows(window_start,identity,attempts)
    SELECT slot,sha256(convert_to('unrelated-' || i,'UTF8')),60 FROM generate_series(1,8192) AS i;
  IF reserve_login_attempt(pair,source,account) IS NOT NULL THEN RAISE EXCEPTION 'exhausted pair was evicted'; END IF;
  IF reserve_login_attempt(other_pair,other_source,account) IS NULL THEN RAISE EXCEPTION 'fresh pair inherited unrelated failures'; END IF;
  PERFORM clear_login_attempt(slot,other_pair,other_source,account);
  UPDATE login_attempt_windows SET attempts=36 WHERE identity=account;
  PERFORM reserve_login_attempt(other_pair,other_source,account);
  PERFORM reserve_login_attempt(other_pair,other_source,account);
  IF reserve_login_attempt(other_pair,other_source,account) IS NOT NULL THEN RAISE EXCEPTION 'account pressure lost'; END IF;
  UPDATE login_attempt_windows SET attempts=60 WHERE identity=source;
  IF reserve_login_attempt(other_pair,source,account) IS NOT NULL THEN RAISE EXCEPTION 'source limit lost'; END IF;
  INSERT INTO login_attempt_windows VALUES(slot-interval '1 minute',pair,60);
  PERFORM reserve_login_attempt(pair,source,account);
  IF EXISTS(SELECT FROM login_attempt_windows WHERE window_start<slot) THEN RAISE EXCEPTION 'expired windows retained'; END IF;
END;
$$;
ROLLBACK;

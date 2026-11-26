ALTER TABLE users ADD COLUMN passkey_handle uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE users ADD COLUMN passkey_revision_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- Discoverable login starts before the account is known. Compare the start time
-- with its eventual owner's latest security change while holding the account lock.
CREATE FUNCTION stamp_passkey_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.passkey_revision_at := clock_timestamp();
    RETURN NEW;
END $$;
CREATE TRIGGER passkey_revision BEFORE UPDATE OF account_revision ON users
    FOR EACH ROW WHEN (OLD.account_revision IS DISTINCT FROM NEW.account_revision)
    EXECUTE FUNCTION stamp_passkey_revision();

CREATE TABLE passkeys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL REFERENCES users,
    rp_id text NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    credential_id bytea NOT NULL UNIQUE,
    credential jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);
CREATE INDEX passkeys_owner ON passkeys(username,rp_id);

CREATE TABLE passkey_challenges (
    token bytea PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('login','register')),
    origin text NOT NULL,
    source bytea NOT NULL,
    username text REFERENCES users,
    session_id uuid,
    revision bigint,
    label text NOT NULL,
    session_data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
    CHECK (CASE WHEN kind='register' THEN username IS NOT NULL AND session_id IS NOT NULL AND revision IS NOT NULL
                ELSE username IS NULL AND session_id IS NULL AND revision IS NULL END)
);

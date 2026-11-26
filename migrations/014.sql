CREATE TABLE login_challenges (
    token bytea PRIMARY KEY,
    username text NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    expires timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
    remaining integer NOT NULL DEFAULT 5 CHECK (remaining >= 0)
);
CREATE INDEX login_challenge_expiry ON login_challenges(expires);

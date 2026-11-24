ALTER TABLE sessions
    ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    ADD COLUMN started_at timestamptz,
    ADD COLUMN browser text NOT NULL DEFAULT '';
UPDATE sessions SET started_at=expires-interval '30 minutes';
ALTER TABLE sessions ALTER COLUMN started_at SET NOT NULL, ALTER COLUMN started_at SET DEFAULT now();
CREATE INDEX sessions_user_expiry ON sessions(username,expires);

CREATE TABLE mfa_enrollments (
    username text NOT NULL REFERENCES users,
    binding text NOT NULL,
    revision bigint NOT NULL,
    secret text NOT NULL,
    expires timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
    PRIMARY KEY(username,binding)
);

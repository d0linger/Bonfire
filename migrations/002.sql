CREATE TABLE sessions (token bytea PRIMARY KEY, username text REFERENCES users NOT NULL, expires timestamptz NOT NULL);
ALTER TABLE users ADD COLUMN otp_secret text;
ALTER TABLE users ADD COLUMN otp_last bigint NOT NULL DEFAULT -1;
CREATE TABLE recovery_codes (username text REFERENCES users, digest bytea, PRIMARY KEY(username,digest));
CREATE TABLE event_closures(event uuid REFERENCES events, version int NOT NULL, snapshot jsonb NOT NULL, reviewer text NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event,version));


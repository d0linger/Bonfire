-- Financial records keep referencing the original users.name after a login is renamed.
ALTER TABLE users ADD COLUMN login_alias text;
ALTER TABLE users ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN account_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
CREATE UNIQUE INDEX users_login_identifier ON users ((coalesce(login_alias,name)));
CREATE TABLE password_changes (
    token bytea PRIMARY KEY, username text NOT NULL REFERENCES users,
    expires timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);

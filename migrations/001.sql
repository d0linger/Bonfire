CREATE TABLE IF NOT EXISTS users (
 name text PRIMARY KEY, password text NOT NULL, role text NOT NULL CHECK(role IN ('Leitung','Kassa','Prüfung')), active boolean NOT NULL DEFAULT true
);
CREATE TABLE events (
 id uuid PRIMARY KEY, name text NOT NULL, starts date NOT NULL, ends date NOT NULL CHECK (ends >= starts),
 closed boolean NOT NULL DEFAULT false, accounts boolean NOT NULL DEFAULT false
);
CREATE TABLE grants_event (
 username text REFERENCES users, event uuid REFERENCES events, PRIMARY KEY(username,event)
);
CREATE SEQUENCE number_blocks START 1;
CREATE TABLE devices (
 id uuid PRIMARY KEY, username text NOT NULL REFERENCES users, event uuid NOT NULL REFERENCES events, name text NOT NULL,
 secret bytea NOT NULL, expires timestamptz NOT NULL, sealed boolean NOT NULL DEFAULT false,
 block bigint NOT NULL UNIQUE DEFAULT nextval('number_blocks'), last_seq bigint NOT NULL DEFAULT 0
);
CREATE TABLE entries (
 event uuid REFERENCES events, id text, revision bigint NOT NULL, device uuid REFERENCES devices,
 kind text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(event,id)
);
CREATE TABLE operations (
 id uuid PRIMARY KEY, event uuid NOT NULL REFERENCES events, device uuid NOT NULL REFERENCES devices,
 seq bigint NOT NULL, digest bytea NOT NULL, target text NOT NULL, base bigint NOT NULL, kind text NOT NULL,
 data jsonb NOT NULL, outcome text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(device,seq)
);
CREATE TABLE audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event uuid REFERENCES events, username text NOT NULL,
 action text NOT NULL, subject text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE originals (
 event uuid REFERENCES events, subject text NOT NULL, number bigint NOT NULL UNIQUE,
 device uuid REFERENCES devices, pdf bytea NOT NULL, docx bytea NOT NULL, snapshot jsonb NOT NULL,
 PRIMARY KEY(event,subject)
);


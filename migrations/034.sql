CREATE TABLE wallet_catalog (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
    note text NOT NULL DEFAULT '',
    default_bar text NOT NULL DEFAULT '',
    float_cents bigint CHECK (float_cents BETWEEN 0 AND 999999999999),
    pieces jsonb CHECK (jsonb_typeof(pieces) = 'object'),
    active boolean NOT NULL DEFAULT true,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
CREATE UNIQUE INDEX wallet_catalog_name ON wallet_catalog(lower(btrim(name)));

CREATE TABLE event_catalog_wallets (
    event uuid NOT NULL,
    wallet uuid NOT NULL REFERENCES wallet_catalog(id),
    local_id text NOT NULL,
    PRIMARY KEY (event,wallet),
    UNIQUE (event,local_id),
    FOREIGN KEY (event,local_id) REFERENCES entries(event,id) ON DELETE CASCADE
);
CREATE INDEX event_catalog_wallets_wallet ON event_catalog_wallets(wallet);

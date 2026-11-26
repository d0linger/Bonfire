ALTER TABLE devices ADD COLUMN online_actor boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX devices_online_user_event ON devices(event,username) WHERE online_actor;

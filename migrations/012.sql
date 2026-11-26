ALTER TABLE operations ADD COLUMN local_time timestamptz;
ALTER TABLE audit ADD COLUMN actor_device uuid REFERENCES devices
    DEFAULT nullif(current_setting('bonfire.device',true),'')::uuid;

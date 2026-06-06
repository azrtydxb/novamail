-- Monotonic config epoch. The Admin API stamps each config.changed event with
-- nextval so data-plane services can ignore stale/replayed events.
CREATE SEQUENCE IF NOT EXISTS config_epoch_seq;

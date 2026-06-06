-- Global, hot-reloadable operational settings (key/value JSON). Seeded with the
-- defaults the data plane uses when a key is absent.
CREATE TABLE settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
    ('max_message_bytes', '52428800'::jsonb),   -- 50 MiB submission cap
    ('retention_days',    '30'::jsonb)           -- prune messages/events older than this
ON CONFLICT (key) DO NOTHING;

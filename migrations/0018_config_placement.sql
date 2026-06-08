-- Move operational settings out of env into the DB (config-placement rule):
-- anything operator-tunable / per-deployment is a settings row, managed via the
-- GUI and read by the planes from Postgres — never env.
--   hostname                     — relay identity / SMTP EHLO banner (ingress, dsn)
--   deliverability_interval_hours — periodic deliverability check cadence (admin-api)
INSERT INTO settings (key, value) VALUES
    ('hostname',                      '"novamail.local"'::jsonb),
    ('deliverability_interval_hours', '6'::jsonb)
ON CONFLICT (key) DO NOTHING;

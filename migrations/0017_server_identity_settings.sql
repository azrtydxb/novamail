-- Server-identity operational settings, managed via the GUI (Settings page) and
-- read by both planes from Postgres — never from env. Postgres is the single
-- source of truth for operational config (two-plane invariant).
--   alert_from  — From address for deliverability alert emails (relayed via self)
--   direct_helo — EHLO/HELO FQDN for direct-to-MX delivery (needs matching PTR)
INSERT INTO settings (key, value) VALUES
    ('alert_from',  '""'::jsonb),
    ('direct_helo', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;

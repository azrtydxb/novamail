-- Enable/disable flags surfaced by the management GUI for accounts and relay
-- domains (providers/routing_rules/rate_limits already have `enabled`).
ALTER TABLE accounts      ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE relay_domains ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

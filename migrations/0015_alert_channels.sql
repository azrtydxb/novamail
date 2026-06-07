-- Deliverability alerting (Phase 4). Idempotent. alert_channels holds the
-- notification destinations: a webhook (URL envelope-encrypted in `secret`, never
-- plaintext) or email (recipient addresses in `target`, delivered through the
-- relay itself). domain_alert_state drives edge-triggered + debounced detection.
CREATE TABLE IF NOT EXISTS alert_channels (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    type         text NOT NULL DEFAULT 'webhook',
    target       text,                                  -- email: address(es); webhook: null
    secret       text,                                  -- webhook: envelope-encrypted URL; email: null
    min_severity text NOT NULL DEFAULT 'warning',
    enabled      boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Idempotent column/constraint upgrades (in case an earlier webhook-only version
-- of this table already exists).
ALTER TABLE alert_channels ADD COLUMN IF NOT EXISTS target text;
ALTER TABLE alert_channels DROP CONSTRAINT IF EXISTS alert_channels_type_check;
ALTER TABLE alert_channels ADD CONSTRAINT alert_channels_type_check CHECK (type IN ('webhook','email'));
ALTER TABLE alert_channels DROP CONSTRAINT IF EXISTS alert_channels_min_severity_check;
ALTER TABLE alert_channels ADD CONSTRAINT alert_channels_min_severity_check CHECK (min_severity IN ('warning','error'));

CREATE TABLE IF NOT EXISTS domain_alert_state (
    domain              text PRIMARY KEY,
    last_alerted_status text NOT NULL,   -- last status we fired/cleared on (ok|warning|error)
    pending_status      text,            -- candidate status being debounced
    consecutive         int  NOT NULL DEFAULT 0,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Deliverability alerting (Phase 4). Idempotent. alert_channels holds the
-- notification destinations; the webhook URL (which may embed a token) is stored
-- envelope-encrypted in `secret`, never plaintext. domain_alert_state drives the
-- edge-triggered + debounced regression detection.
CREATE TABLE IF NOT EXISTS alert_channels (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    type         text NOT NULL CHECK (type IN ('webhook')),
    secret       text,                                  -- envelope-encrypted webhook URL
    min_severity text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('warning','error')),
    enabled      boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_alert_state (
    domain              text PRIMARY KEY,
    last_alerted_status text NOT NULL,   -- last status we fired/cleared on (ok|warning|error)
    pending_status      text,            -- candidate status being debounced
    consecutive         int  NOT NULL DEFAULT 0,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Suppression list: recipients that hard-bounced or complained are skipped on
-- subsequent sends. Addresses are stored lowercased (matched case-insensitively).
CREATE TABLE suppressions (
    address    text PRIMARY KEY,
    reason     text NOT NULL CHECK (reason IN ('hard_bounce','complaint','manual')),
    source     text,
    detail     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz
);

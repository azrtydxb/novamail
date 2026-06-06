-- Per-recipient-domain rate limits (spec §6/§7). Enforced in the delivery
-- worker as a token bucket. A row with domain '*' is the default for any domain
-- without a specific row; absence of both means unlimited.

BEGIN;

CREATE TABLE rate_limits (
    domain     text PRIMARY KEY,        -- recipient domain, or '*' for default
    per_second double precision NOT NULL CHECK (per_second > 0),
    burst      integer NOT NULL DEFAULT 1 CHECK (burst >= 1),
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

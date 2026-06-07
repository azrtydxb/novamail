-- Deliverability check persistence (Phase 3). Idempotent (the migrate job re-runs
-- every file). domain_dns_checks holds the latest per-record result so the GUI
-- reads a cache instead of resolving live on every load; domain_dns_history is an
-- append-only rollup timeline that drives the dashboard tile + regression
-- detection (Phase 4 alerting).
CREATE TABLE IF NOT EXISTS domain_dns_checks (
    domain     text NOT NULL,
    record     text NOT NULL,
    selector   text NOT NULL DEFAULT '',
    status     text NOT NULL,
    found      text,
    expected   text,
    detail     text,
    fix        text,
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, record, selector)
);

CREATE TABLE IF NOT EXISTS domain_dns_history (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain text NOT NULL,
    status text NOT NULL,   -- domain rollup status at check time (ok|warning|error)
    at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_domain_dns_history_domain_at
    ON domain_dns_history (domain, at DESC);

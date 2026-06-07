-- Index for the /metrics provider-health query, which does
--   SELECT DISTINCT ON (provider) provider, at, kind ... ORDER BY provider, at DESC
-- Without this it full-scans + sorts message_events on every dashboard refresh.
CREATE INDEX IF NOT EXISTS idx_message_events_provider_at
    ON message_events (provider, at DESC)
    WHERE provider IS NOT NULL;

-- Supports the per-kind 24h rollups (count/series grouped by kind over a time window).
CREATE INDEX IF NOT EXISTS idx_message_events_at_kind
    ON message_events (at DESC, kind);

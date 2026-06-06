-- Message bodies in Postgres (bytea), replacing the shared-filesystem (RWX)
-- store. The bus still carries only a reference (the body id = message id); the
-- blob is written once by ingress and read once by delivery, then GC'd. Kept in
-- its own table so a body can be deleted post-delivery while the message row
-- (status/events/metadata) is retained for tracing.
CREATE TABLE IF NOT EXISTS message_bodies (
    id         text PRIMARY KEY,
    body       bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

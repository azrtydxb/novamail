-- novamail initial schema (spec §9). Postgres is the single source of truth for
-- config + message metadata + audit. The work queue lives in RabbitMQ, NOT here.
-- Body bytes live in the shared file store; only a reference is kept here.

BEGIN;

-- ---- Operational config (GUI-edited) -------------------------------------

CREATE TABLE accounts (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username               text NOT NULL UNIQUE,
    password_hash          text NOT NULL,
    allowed_sender_domains text[] NOT NULL DEFAULT '{}',
    ip_allowlist           cidr[] NOT NULL DEFAULT '{}',
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relay_domains (
    domain     text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE providers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL UNIQUE,
    type       text NOT NULL CHECK (type IN ('gmail','ses','m365','smtp')),
    endpoint   text,
    auth_mode  text CHECK (auth_mode IN ('xoauth2','smtp-auth','ip','iam')),
    enabled    boolean NOT NULL DEFAULT true,
    secret_ref text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routing_rules (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_domain text,
    sender_domain    text,
    provider_chain   uuid[] NOT NULL,   -- provider ids; [0] primary, rest failover
    priority         integer NOT NULL DEFAULT 100,
    enabled          boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dkim_keys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain       text NOT NULL,
    selector     text NOT NULL,
    private_ref  text NOT NULL,         -- envelope-encrypted secret ref
    public_key   text NOT NULL,
    rotation     text NOT NULL DEFAULT 'active' CHECK (rotation IN ('active','retiring','revoked')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain, selector)
);

CREATE TABLE tls_policy (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    min_version      text NOT NULL DEFAULT '1.2',
    starttls_required boolean NOT NULL DEFAULT true,
    provider_id      uuid REFERENCES providers(id) ON DELETE CASCADE  -- null = global default
);

-- ---- Message metadata + tracing -----------------------------------------

CREATE TABLE messages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mail_from   text NOT NULL,
    rcpt_to     text[] NOT NULL,
    body_ref    text NOT NULL,          -- key in the shared file store
    body_backend text NOT NULL DEFAULT 'fs' CHECK (body_backend IN ('fs','pg')),
    status      text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','relayed','deferred','bounced','failed')),
    attempts    integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_status_idx  ON messages (status);
CREATE INDEX messages_created_idx ON messages (created_at);

CREATE TABLE message_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('queued','relayed','deferred','bounced','failed')),
    provider   text,
    detail     text,
    at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_events_msg_idx ON message_events (message_id, at);

-- ---- Audit (append-only) -------------------------------------------------

CREATE TABLE audit_log (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor     text NOT NULL,
    action    text NOT NULL,
    target    text,
    detail    jsonb,
    at        timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- Inbound overhaul, part 1: trusted relay clients (IP/CIDR ranges that may relay
-- without SMTP AUTH) and generalize rate_limits to carry a direction (in/out)
-- and a scope (account | ip | recipient_domain | provider | global).

BEGIN;

CREATE TABLE relay_clients (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cidr                   cidr NOT NULL UNIQUE,
    description            text,
    allowed_sender_domains text[] NOT NULL DEFAULT '{}',
    enabled                boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT now()
);

-- Generalize rate_limits. Existing rows are outbound per-recipient-domain limits.
ALTER TABLE rate_limits ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE rate_limits ADD COLUMN direction text NOT NULL DEFAULT 'out';
ALTER TABLE rate_limits ADD COLUMN scope text NOT NULL DEFAULT 'recipient_domain';
ALTER TABLE rate_limits RENAME COLUMN domain TO scope_value;
ALTER TABLE rate_limits DROP CONSTRAINT rate_limits_pkey;
ALTER TABLE rate_limits ADD PRIMARY KEY (id);
ALTER TABLE rate_limits ADD CONSTRAINT rate_limits_scope_uniq UNIQUE (direction, scope, scope_value);
ALTER TABLE rate_limits ADD CONSTRAINT rate_limits_direction_chk CHECK (direction IN ('in','out'));
ALTER TABLE rate_limits ADD CONSTRAINT rate_limits_scope_chk
    CHECK (scope IN ('account','ip','recipient_domain','provider','global'));

COMMIT;

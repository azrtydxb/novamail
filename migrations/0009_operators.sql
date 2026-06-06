-- Management-plane operators (GUI/Admin API login). Distinct from `accounts`,
-- which are SMTP submission credentials. Roles gate write access.
CREATE TABLE operators (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')),
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

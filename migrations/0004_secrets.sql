-- Envelope-encrypted secret material (provider credentials, DKIM private keys),
-- referenced by providers.secret_ref / dkim_keys.private_ref. The envelope is an
-- AES-256-GCM data key wrapped by the master KEK (env/k8s Secret). Never
-- plaintext (spec §10).
CREATE TABLE secrets (
    ref        text PRIMARY KEY,
    envelope   text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

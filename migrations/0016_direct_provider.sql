-- Direct-to-MX delivery (v2). Allows a provider of type 'direct', which resolves
-- the recipient domain's MX per message and delivers on port 25 (opportunistic
-- STARTTLS) instead of relaying through an authenticated upstream. Idempotent.
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_type_check;
ALTER TABLE providers ADD CONSTRAINT providers_type_check
    CHECK (type IN ('gmail','ses','m365','smtp','direct'));

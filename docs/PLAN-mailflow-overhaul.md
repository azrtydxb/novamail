# Plan — mail-flow overhaul (Incoming · Routing · Outgoing · Observe)

Restructures the management plane around the **mail flow** and closes the
enforcement gaps. Everything below is in scope **except** the spec's v2 items
(multi-tenancy/RBAC, inbound SPF/DKIM *verification*, MTA-STS/DANE,
direct-to-MX). Each PR is shipped through CI and verified on the kw cluster.

Two-plane rule preserved throughout: the GUI talks only to the Fastify Admin
API; new telemetry/control endpoints live in the management plane; the Go
data-plane binaries never gain GUI knowledge.

---

## 1. Information architecture (GUI)

```
INCOMING                         ROUTING                    OUTGOING
─ Relay clients (trusted CIDRs)  ─ Relay domains (gate)     ─ Providers (SES/M365/Gmail/SMTP)
─ Accounts (auth + IP pinning)   ─ Routing rules            ─ DKIM & ARC (keys/selectors/rotation)
─ Inbound rate limits              (recip→sender→default,   ─ Outbound rate limits (domain / provider)
─ Inbound policy (TLS/mTLS,         failover chains)        ─ Outbound policy (per-provider TLS)
   listeners, size/rcpt caps,
   retry policy)

OBSERVE
─ Dashboard · Messages (trace) · Queue (+ DLQ redrive) · Suppressions · Audit log · Operators
```

Existing screens move in; new screens are **Relay clients, Inbound/Outbound
rate limits (split), Inbound policy, DKIM & ARC, Suppressions, Audit log,
Operators**, plus a real **Login**.

---

## 2. Schema (migrations 0006–00010)

- **0006 — relay clients + generalized rate limits**
  - `relay_clients(id uuid pk, cidr cidr unique, description text, allowed_sender_domains text[] default '{}', enabled bool default true, created_at)` — trusted ranges that relay **without** SMTP AUTH.
  - `rate_limits`: add `id uuid` surrogate pk, `direction text check (in|out) default 'out'`, `scope text check (account|ip|recipient_domain|provider|global) default 'recipient_domain'`; rename `domain → scope_value`; `unique(direction,scope,scope_value)`. Existing rows backfill to `out/recipient_domain`.
- **0007 — message headers**: `messages` add `subject text`, `message_id text`, `size_bytes bigint`.
- **0008 — operators + audit attribution**: `operators(id, username unique, password_hash, role check(admin|viewer), enabled, created_at)`. `audit_log` already exists; start writing to it.
- **0009 — suppression**: `suppressions(address citext pk, reason check(hard_bounce|complaint|manual), source text, detail text, created_at, expires_at null)`.
- **00010 — policy/limits**: `settings(key text pk, value jsonb)` for global config (max_message_bytes, max_rcpts, retry tiers, default TLS policy). Wire the existing `tls_policy` table (per-provider/global).

All config tables emit `config.changed` on write (existing fanout) → data-plane hot-reload.

---

## 3. Data-plane enforcement

### Ingress (`cmd/ingress`) — becomes config-driven + hot-reloaded (like delivery)
On connect, capture the client IP (`smtp.Conn.Conn().RemoteAddr`). Build an
inbound snapshot from Postgres (relay_clients, relay_domains, accounts incl.
`ip_allowlist`, inbound rate_limits, suppressions, settings/tls_policy),
swapped atomically on `config.changed`.

- **Trusted-CIDR relay (no AUTH):** source IP ∈ an enabled `relay_clients.cidr` → session authorized with that client's `allowed_sender_domains`.
- **Account IP pinning:** on AUTH success, if `accounts.ip_allowlist` is non-empty and the source IP ∉ it → reject `535`.
- **Authorization gate:** `MAIL FROM` requires AUTH **or** trusted IP (`530` otherwise).
- **Relay-domain gate:** `MAIL FROM` domain ∈ effective allowed-sender set **and** (if any `relay_domains` configured) ∈ `relay_domains` → else `550`.
- **Suppression:** `RCPT TO` in `suppressions` → `550` (skip the recipient).
- **Inbound rate limiting:** token bucket per scope (`account` / `ip` / `global`) from `rate_limits(direction='in')`; over budget → `451` (client retries).
- **Header capture:** in `DATA`, tee the stream → parse `Subject`/`Message-Id`, record `size_bytes`, store on the message row (no full-body parse; bounded header read).
- **DSN request params:** honor `MAIL FROM ... RET=` and `RCPT ... NOTIFY=` (RFC 3461) — carried on the relay job for the DSN generator.

### Delivery (`cmd/delivery`)
- **Per-provider outbound rate limit:** in addition to the recipient-domain bucket, a provider-scoped bucket from `rate_limits(direction='out', scope='provider')`, checked before handing off to that provider.
- **ARC sealing:** when relaying (forwarded mail), ARC-seal in addition to DKIM (`go-msgauth/dkim` + ARC), preserving auth-results.
- **DB-driven DKIM:** load selectors/keys from `dkim_keys` (decrypted via the KEK) instead of the single mounted key; sign with the domain's active selector.
- **Suppression double-check** + **configurable retry tiers** (from `settings`).
- **Body GC:** after a successful relay (ack) → `store.Delete(bodyRef)`.

### DSN (`cmd/dsn`)
- After generating a bounce → `store.Delete` the original body (GC).
- **Feedback loop:** on a permanent (5xx) failure, add the recipient to `suppressions` (`hard_bounce`).
- Honor `NOTIFY`/`RET` from the job when building the DSN.

### Listeners — SMTP / SMTPS / submission
Container listens on **25** (SMTP relay, STARTTLS, optional), **587**
(submission, STARTTLS), **465** (SMTPS, implicit TLS). Helm: an SMTP
**LoadBalancer** (kube-vip IP, `externalTrafficPolicy=Cluster`) exposing
25/587/465; per-port enable in values; AUTH only over TLS.

### Retention / pruning
A maintenance routine (k8s **CronJob** running SQL + body GC) prunes
`messages`/`message_events` past a configurable retention window and sweeps
orphaned bodies (in store but not referenced by a non-terminal message).

---

## 4. Admin API (management plane)

- **CRUD:** relay_clients; rate_limits (new shape); suppressions; operators; settings; tls_policy; dkim_keys (with key generation + rotation; private key envelope-encrypted via the existing `secrets` path).
- **Real auth:** `POST /api/auth/login` (verify `operators` password, return an HS256 bearer token); `GET /api/auth/me`. The `onRequest` hook accepts a **valid operator bearer token _or_** the static `x-api-key` (automation). nginx **stops injecting** the key for the GUI; the GUI logs in and sends its own token.
- **Audit:** every mutating request writes `audit_log` (operator, action, target, before/after) — done in one hook.
- **Bounce/complaint webhook:** `POST /api/feedback/:provider` (e.g. SES SNS) → suppressions, signature/secret-verified.
- **DLQ control:** `GET /api/dlq` (peek), `POST /api/dlq/redrive` (republish to `relay.work`), `POST /api/messages/:id/requeue`, `POST /api/queues/:name/purge` — admin-api publishes via amqplib.
- **Telemetry:** existing `/api/metrics` + `/api/queues`; extend messages with subject/size.

---

## 5. GUI

- New nav groups (Incoming/Routing/Outgoing/Observe) + new screens listed in §1.
- Real **Login** → `/api/auth/login`; token in memory/localStorage; sent on every call.
- **Account** form gains an `ip_allowlist` CIDR editor.
- **Rate limits** editor reused under Incoming (direction=in) and Outgoing (direction=out) with scope selectors.
- **Queue** screen: wire **DLQ redrive / purge**; **Messages**: wire **requeue** + show subject/size.
- **Suppressions / Audit / Operators** screens.

---

## 6. PR sequence (each: CI green → deploy → verify on kw)

| PR | Scope | Verify |
|----|-------|--------|
| **A** | migr 0006/0007; model+loaders; admin-api CRUD (relay_clients, new rate_limits); **body GC** (delivery/dsn `store.Delete`); **header capture** (subject/size) | bodies deleted post-relay; messages show subject; rate_limits still work |
| **B** | ingress inbound enforcement (trusted-CIDR relay, account IP pinning, relay-domain gate, inbound rate limit, suppression check) + **hot reload** + **25/465/587 listeners + LB** | IP-auth relay (no AUTH from trusted CIDR); wrong-IP account rejected; inbound throttle 451; submit on 25/465/587 |
| **C** | delivery **per-provider** outbound rate limits; configurable retry tiers + DSN NOTIFY/RET | provider cap throttles; retry tiers from settings |
| **D** | **suppression + bounce feedback** (migr 0009, dsn auto-suppress on 5xx, ingress/delivery skip, admin-api CRUD + webhook) | hard-bounce → suppressed → next send skipped |
| **E** | **DB-driven DKIM + ARC** (migr; dkim_keys mgmt; delivery ARC seal) | DKIM from DB selector; ARC-Seal header present |
| **F** | **real admin auth + audit** (migr 0008; operators; bearer; audit writes; `/api/audit`; nginx stops key-inject; GUI login/Audit/Operators) | login required; audit row per change |
| **G** | **DLQ redrive/requeue** + **retention CronJob** + **settings/limits** (max size, caps, tls_policy) | redrive moves DLQ→work; prune deletes old rows |
| **H** | **GUI restructure** (Incoming/Routing/Outgoing/Observe) + all new screens + account IP editor + Messages subject/requeue | browser-tested IA + each new screen |

(Order keeps the cluster working at every step; GUI restructure last so screens land against finished APIs. E can move earlier if you want auth gated sooner.)

---

## 7. Open decisions (defaults I'll take unless you say otherwise)
1. **Operator auth:** HS256 JWT (stateless), secret in a new k8s secret. Seed one admin operator on first migrate. *(alt: opaque sessions table)*
2. **relay_domains semantics:** gate on **sender** (`MAIL FROM`) domain — the domains this relay is authoritative for. *(not recipient)*
3. **Suppression match:** exact address (citext). *(alt: + domain wildcards)*
4. **Bounce webhook:** start with **SES SNS** shape; generic JSON for others.
5. **Retention default:** 30 days for `message_events`, bodies deleted at relay. Tunable via `settings`.

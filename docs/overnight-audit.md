# Overnight audit — findings & disposition (2026-06-07)

Four parallel read-only audits (security, stubs/incomplete, best-practices+metrics,
test-coverage). Tracked here; each batch lands as an auto-merged PR.

## Security (most severe first)
- **C1 fail-open auth secret** — `betterauth.ts` fell back to `"dev-secret-change-me"`; secret could be unset. → **fail-fast if unset; drop the hardcoded default.** [PR: security]
- **C2 anonymous full access** — `server.ts` onRequest: `if (!apiKey) { actor=anonymous; return }` fails open and skips the role gate. → **fail-closed: no session + no valid key ⇒ 401.** [PR: security]
- **H1 open feedback webhook** — `/api/feedback/*` exempt from auth → suppression injection. → **require auth (api-key); drop the blanket exemption.** [PR: security]
- **H2 SMTP PLAIN over non-TLS / InsecureSkipVerify** — guard PLAIN auth behind TLS. [PR: data-plane]
- **H3 no TLS to PG/RabbitMQ** — `sslmode=disable`. → mTLS PR (PG verify-full, AMQPS). [PR: mTLS]
- **H4 audit gaps** — auth mutations not audited, write failure swallowed. [PR: observability]
- **M3 unbounded recipients** — add MaxRecipients + address validation. [PR: data-plane]
- **M5 over-broad deployer RBAC (`secrets: *`)** — scope verbs. [PR: helm]
- **L3 localhost trustedOrigins in prod** — gate to dev. [PR: security]
- Positive: envelope crypto correct, secrets never returned/logged, queries parameterized, not an open relay by default, Go pods hardened.

## Stubs / incomplete
- **SES/M365 are generic SMTP** — `AWS-SIGV4`/`iam` maps to nothing. → honest: document "paste SES SMTP creds", or implement SigV4 password derivation. [PR: data-plane/docs]
- **tls_policy table dead** — CRUD exists, never enforced. → wire into provider build OR remove. [PR: data-plane]
- **relay-domain create `enabled: !!f.verified || true`** — always true (bug). [PR: gui]
- **SSO button** — hardcoded error toast. → remove/gate. [PR: gui]
- **Fake metrics shown as live**: p50/p95=0, dkimSigned=100, per-row 24h counters=0, provider lastUsed='—', dashboard delta captions hardcoded. → compute or remove. [PR: observability/gui]
- `Send` error discarded (`res,_ :=`) — coerce err→Defer. [PR: data-plane]
- `Capabilities` referenced in CLAUDE.md but not on the interface — doc drift.

## Best-practices + metrics
- **A1 no anti-affinity/topology spread** — both replicas can co-locate. [PR: helm]
- **A2 rollout strategy/preStop/grace** — delivery in-flight handle not awaited on SIGTERM. [PR: helm + delivery]
- **A3 provider dials ignore ctx deadline** — black-holed connect hangs past 60s. [PR: data-plane]
- **B1 metrics: no provider label, no latency histogram, no rate-limit/auth counters.** [PR: observability]
- **B2 dsn exposes NO metrics** (no /metrics, no bounce counters). [PR: observability]
- **B3 ServiceMonitor only ingress+delivery** (dsn/admin-api/web unscraped). [PR: observability]
- **B4 admin-api p50/p95 hardcoded 0.** [PR: observability]
- A5 no Fastify body schemas; A6 inbound rate-limit semantics; A10 minimal golangci.

## Tests (highest value)
- **P0 inbound policy** (`cmd/ingress/inbound.go`: sendersAllow/ipInAny/matchClient/relayDomainOK/remoteIP) — open-relay surface, untested. [PR: tests]
- **P1 secrets envelope Go↔TS interop** — dual impl, no contract test. [PR: tests]
- **P1 admin-api `pick()` CRUD whitelist** — injection guard. [PR: tests]
- **P2 amqp `TierForAttempt`, PgStore, role hook.** [PR: tests]
- Wire `npm test` into CI; no coverage measured today.

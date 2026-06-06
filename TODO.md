# novamail — Build TODO

Derived from `smtp-relay-handover-spec.md`. Front-loaded with **M0 (walking skeleton + CI/CD)** so that build → test → deploy to the **kw** k3s cluster works end-to-end before the real relay logic lands; then the spec milestones M1–M5 fill it in.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

## Cluster/CI facts (kw)
- Repo: `github.com/azrtydxb/novamail`. kubeconfig context `kw` (ARM64 k3s v1.34.4).
- Runners: ARC scale sets `arc-azrtydxb` (compute/test/deploy) and `arc-azrtydxb-publish` (image push, ghcr trust chain).
- Images: build native per-arch, push to `ghcr.io/azrtydxb/novamail`; arm64 buildcache → `192.168.10.123:5000/buildcache/...`, amd64 via remote BuildKit. Mirror release images to Zot `192.168.10.123:5000`.
- Deploy: **Helm `upgrade --install` from an ARC runner** (in-cluster) against namespace `novamail`.
- Ingress: ingress-nginx, host `*.kw.local`, `externalTrafficPolicy=Cluster`, cert-manager `cluster-ca` ClusterIssuer.
- Storage: Longhorn — `longhorn` (default, 3-replica), `longhorn-single`. **Body store = Longhorn RWX PVC** (or NAS NFS `192.168.10.253`).

---

## M0 — Walking skeleton + CI/CD (deploy to kw end-to-end)
- [ ] `go.mod` (module `github.com/azrtydxb/novamail`, Go 1.23+), `Taskfile.yml` (build/test/lint per service).
- [ ] `cmd/ingress` minimal: opens SMTP listener (`emersion/go-smtp`) that accepts+discards, plus HTTP `/healthz` + `/readyz` + Prometheus `/metrics`.
- [ ] `internal/store` interface + `fsstore` (filesystem, RWX path) impl + `pgstore` (bytea) stub.
- [ ] Multi-stage `Dockerfile` (distroless, non-root, arm64+amd64), `.dockerignore`.
- [ ] `deploy/helm/novamail` chart: Deployment, Service, Ingress (`ingress.kw.local`), probes, RWX PVC for body store, ServiceMonitor, values for image tag/registry.
- [ ] `.github/workflows/ci.yml` — `go vet` + `golangci-lint` + `go test -race` on `arc-azrtydxb`; build image on push to main.
- [ ] `.github/workflows/pr-checks.yml` — lint/test/`all-checks-passed` gate.
- [ ] `.github/workflows/release.yml` — per-arch build → manifest → ghcr → mirror to Zot → helm package/push.
- [ ] `.github/workflows/deploy.yml` — `helm upgrade --install` to `novamail` ns from ARC runner (in-cluster RBAC: ServiceAccount + Role/RoleBinding).
- [ ] Verify: green pipeline + `https://ingress.kw.local/healthz` reachable on kw.

## M0.5 — Dependency stack on kw (lightweight, single-instance)
- [x] Postgres (Longhorn PVC) — Helm subchart or separate release in `novamail-deps` ns.
- [x] RabbitMQ 4.x (single node now, quorum-queue config; 3-node in M2).
- [x] Body-store RWX PVC wired into ingress + delivery.
- [x] `/api` shared contracts: relay job schema, `config.changed` event, config DTOs (versioned JSON Schema).
- [x] `/migrations`: initial schema (`messages`, `message_events`, plus config tables stubs).

## M1 — Core relay (single provider)
- [x] Ingress: SMTP AUTH (PLAIN over TLS), STARTTLS:587 + implicit TLS:465, inbound authz (accounts, allowed sender domains).
- [x] Ingress: body → file store, metadata → Postgres, publish job → `relay.work` (topic, key=recipient domain).
- [x] `cmd/delivery`: consume with manual acks, resolve route, fetch body, **generic SMTP provider** handoff, ack on success.
- [x] `internal/dkim`: basic DKIM signing per sending domain.
- [x] End-to-end relay through a generic smarthost proven on kw.

## M2 — Resilience
- [x] Retry tiers: `wait.30s/5m/30m` queues (TTL + DLX back to `relay.work`).
- [x] `relay.dlq` + `cmd/dsn` (RFC 3464 DSN generator) republishing bounces.
- [~] RabbitMQ 3-node quorum cluster (TODO); graceful drain on shutdown (done).

## M3 — Providers + routing
- [x] Providers: Gmail/XOAUTH2 (token refresh), Amazon SES, Microsoft 365 (factory; live creds via M4 secret store).
- [x] Routing engine: recipient-domain → sender-domain → default; per-rule enable + failover chains (DB-driven).
- [ ] Per-domain rate limiting (consumer prefetch/QoS + token budget). [remaining M3]

## M4 — Management plane
- [ ] `services/admin-api` (Fastify + TS): REST over Postgres config schema, validation, `config.changed` fanout publish.
- [ ] Hot reload: data-plane services cache config, subscribe to fanout, reload affected slice live.
- [ ] `web` (React + Vite): config UI (providers/rules/domains/accounts) + message-tracing UI (`message_events`).
- [ ] Secrets: envelope-encryption for provider creds + DKIM keys at rest.

## M5 — Packaging
- [ ] Helm chart hardening (HA defaults), docker-compose, systemd units.
- [ ] cert-manager integration; multi-arch distroless images finalized.

## Cross-cutting
- [ ] ARC seal (ARC sealing for forwarded mail), SPF/DMARC awareness.
- [ ] Prometheus metrics on every service; Grafana dashboard; Loki log correlation by message id.
- [ ] Audit log (`audit_log`) on config writes.

## v2 (deferred)
- Direct-to-MX, MTA-STS/DANE enforcement, inbound SPF/DKIM verification, multi-tenancy/RBAC, audit-replay.

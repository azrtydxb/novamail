# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Milestones **M0–M5 are implemented and running on the kw cluster.** The relay does authenticated, TLS, DKIM-signed, DB-routed delivery with failover, retry tiers, bounces, per-domain rate limiting, a management GUI + Admin API with live config hot-reload, and envelope-encrypted credentials. See `TODO.md` for the milestone checklist and `smtp-relay-handover-spec.md` for the build contract (when spec and code disagree, the spec wins).

Remaining/parked: live Gmail/SES/M365 credential testing (needs real provider accounts). The cluster also runs a Mailpit test sink (`deploy/cluster/deps/mailpit.yaml`) used as the generic-smarthost upstream for verification.

## Repository layout (actual)

```
/cmd            ingress/ delivery/ dsn/      # Go data-plane binaries
/internal       model/ store/ db/ amqp/ providers/ routing/ ratelimit/ dkim/ secrets/
/services/admin-api                          # Fastify + TypeScript management API
/web                                         # React + Vite GUI (served by nginx, proxies /api)
/api                                         # versioned JSON Schema contracts
/migrations     0001..0004 *.sql             # applied in order by deploy/cluster/deps/migrate-job
/deploy
  helm/novamail        # the chart CI deploys (ingress, delivery, dsn, admin-api, web, PVC, PDBs, cert)
  cluster/             # one-time bootstrap: RBAC, deps (postgres, rabbitmq-cluster, mailpit), README
  docker-compose/      # single-host stack
  systemd/             # bare-metal units
Taskfile.yml           # build/test/lint
```

## Commands

- **Go**: `go build ./...`, `go test ./...` (CI runs `go test -race`), `go vet ./...`, `~/go/bin/golangci-lint run ./...` (config `.golangci.yml`, v2). `go.mod` is on **Go 1.25** — keep CI (`golang:1.25`) and the Dockerfile `GO_VERSION` in lockstep.
- **Admin API** (`services/admin-api`): `npm ci && npm run build` (tsc). **Web** (`web`): `npm ci && npm run build` (vite).
- **Helm**: `helm lint deploy/helm/novamail`; render with `helm template novamail deploy/helm/novamail -n novamail --set image.tag=t`.

## CI/CD + cluster (kw)

PR → `pr-checks.yml` (go test/vet, golangci-lint, helm lint, node-check) → merge to `main` → `ci.yml` builds images on ARC runners (Go services multi-arch arm64+amd64; admin-api + web arm64) → push to Zot → `helm upgrade --install` into the `novamail` namespace → rollout. Images are **pulled via their `ghcr.io/...` name** (containerd mirrors ghcr.io → the Zot registry at `192.168.10.123`, cluster-CA TLS). The deploy job runs on the runner pod using a kubeconfig built from its in-cluster SA token (RBAC in `deploy/cluster/bootstrap-rbac.yaml`). 3-node RabbitMQ runs via the **RabbitMQ Cluster Operator** (`nova-bus`).

Two ARM64 CI gotchas (already handled): JS actions (`actions/checkout`) can't run in **Alpine** containers on arm64 runners (use `azure/setup-*`, not `alpine/*` images); and non-root runners can't write `/usr/local/bin`.

## What this is

A cloud-native, horizontally-scalable **SMTP relay** with a management GUI. Clients submit mail; the relay authorizes, queues, DKIM-signs, and forwards each message through a pluggable, authenticated **upstream provider** (Gmail/Workspace XOAUTH2, Amazon SES, Microsoft 365, generic SMTP smarthost). Deploys identically on Kubernetes, Docker, and bare metal.

## Architecture: two decoupled planes

This separation is the central design invariant — preserve it in every change.

- **Management plane** (off the mail path): React+Vite GUI → Fastify Admin API → Postgres. Only reads/writes config and emits change notifications. Never handles mail.
- **Data plane** (runs even if management plane or Postgres is briefly down): Go binaries for ingress, delivery, and DSN generation. Each service caches operational config locally and keeps relaying mail independently.

The two planes communicate **only** through (a) the shared Postgres schema and (b) the versioned schemas in `/api`. The Go data-plane binaries have zero knowledge of the GUI.

## Hard constraints (do not violate without updating the spec)

- **Relay by default; direct-to-MX is now an opt-in provider (v2).** Most messages exit via an authenticated upstream provider. A provider of type `direct` (`internal/providers/direct.go`) is also supported: it resolves the recipient domain's MX per message and delivers on port 25 with opportunistic STARTTLS (RFC 7435, unverified). It is **only used when a `direct` provider is configured and routed to** — the relay path is unchanged otherwise. Operational requirements for direct delivery: **outbound port-25 egress**, a real EHLO FQDN with matching forward + reverse (PTR) DNS (`NOVAMAIL_DELIVERY_HELO` / `delivery.directHelo`), and good sending-IP reputation. IP-warmup automation and MTA-STS/DANE sender enforcement remain out of scope.
- **Postgres is the single source of truth** for operational config. No app config in CRDs, ConfigMaps, or files. The only sanctioned CRDs are cert-manager's (ACME/TLS) and standard service discovery. No SQLite path.
- **The work queue lives in RabbitMQ, not Postgres.** Postgres holds config, message metadata, message bodies, and audit.
- **The bus carries references, not blobs.** Message bodies live in the body store; jobs and `config.changed` events stay small and reference bodies by ID (claim-check).
- **No object store / S3 dependency.** Message bodies are stored in **Postgres by default** (`message_bodies` bytea, keyed by message id) — **no shared filesystem required**. `internal/store` is interface-backed (`store.Open`): Postgres is default; a **filesystem (RWX) backend** remains opt-in via `NOVAMAIL_BODY_STORE=<path>` + `bodyStore.enabled=true`. Body is written once (ingress), read once (delivery), GC'd after relay/bounce; an orphan sweep (maintenance CronJob) cleans strays.
- **Postgres runs HA via the CloudNativePG operator** (`Cluster/novamail-pg`, 3 instances = 1 primary + 2 replicas, quorum **synchronous** replication, automatic failover). Apps connect to the **`novamail-pg-rw`** service (always the current primary). The old single-node StatefulSet is retired. `sslmode=disable` in the DSN (in-cluster; pgx + node-`pg` both connect).
- **RabbitMQ 4.x quorum queues only** on a 3-node cluster. Classic mirroring is removed in 4.x; do not use it.
- **GUI is its own service/image.** Never embed it into a Go binary.
- **`/api` is the integration boundary.** Versioned JSON Schema / protobuf for the relay job, the `config.changed` event, and config DTOs. Never break these silently — Go producers/consumers and the Fastify publisher all depend on them.
- **Secrets** (provider creds, DKIM private keys) are envelope-encrypted at rest, never stored plaintext in Postgres, never logged.

## Tech stack

| Layer | Choice | Key libraries |
|---|---|---|
| Data-plane services | Go | `emersion/go-smtp`, `emersion/go-sasl` (PLAIN/LOGIN/XOAUTH2), `emersion/go-msgauth` (DKIM/ARC), `rabbitmq/amqp091-go`, `pgx` |
| Message bus | RabbitMQ 4.x | Quorum queues only |
| Config/metadata store | PostgreSQL | Single source of truth |
| Message-body store | **Postgres** (`message_bodies` bytea) by default | Keyed by message id; no S3/MinIO/shared-FS. Interface-backed (`store.Open`); filesystem (RWX) backend opt-in |
| Admin API | Fastify (Node + TypeScript) | |
| GUI | React + Vite (TypeScript) | |
| Packaging | Helm, docker-compose, systemd | Multi-arch distroless images |
| Observability | Prometheus, `slog`, health probes | |

## Planned repository layout (monorepo)

```
/cmd          ingress/ delivery/ dsn/   # Go binaries (one per data-plane service)
/internal     smtp/ routing/ providers/ dkim/ amqp/ config/ store/ authz/ model/
/services     admin-api/                # Fastify + TypeScript
/web                                     # React + Vite app (separate build + image)
/api                                     # SHARED CONTRACTS: job, config-event, config DTOs
/deploy       helm/ docker-compose/ systemd/
/migrations                              # SQL migrations (golang-migrate or sqlc-compatible)
Taskfile.yml                             # build/test/lint per service
```

## Commands

No build tooling exists yet. The spec mandates a **`Taskfile.yml`** (go-task) for build/test/lint per service — create it when scaffolding M1. Until then there are no project-specific build, lint, or test commands.

## Message flow & retry model

Ingress accepts → writes body to the body store (Postgres `message_bodies` by default), metadata to Postgres, publishes a job to the `relay.work` topic exchange (routing key = **recipient domain**, so a throttled domain gets its own queue and never head-of-line-blocks others). Delivery worker consumes with **manual acks**, resolves the route, signs, relays to the provider, and acks only after successful upstream handoff.

Retries use pure-core AMQP, no plugins: a transient 4xx → `reject` (no requeue) → message dead-letters into a **wait queue** (`wait.30s`, `wait.5m`, `wait.30m`) with a TTL + DLX pointing back at `relay.work`; on TTL expiry it re-enters delivery. Permanent 5xx / max attempts → `relay.dlq`, consumed by the DSN generator which builds RFC 3464 bounces and republishes them through `relay.work`.

A worker dying mid-delivery leaves its message unacked; RabbitMQ redelivers to another consumer — this is the per-message failover guarantee, no offset bookkeeping.

## Provider & routing model

Providers implement a common `Provider` interface (`Send` → `Delivered | Defer(4xx) | Fail(5xx)`, `Capabilities`, `Name`). Routing precedence per message: **recipient-domain rule → sender-domain rule → default provider.** Each rule is independently toggleable and can define a failover chain; a `Defer`/`Fail` can advance the chain before falling back to the retry tiers.

## Hot reload

Each data-plane service loads operational config at boot, **caches it locally**, and subscribes to a `config.changed` fanout exchange. The Admin API publishes that event after a successful Postgres write; services reload only the affected config slice, live, with no restart. This cache is what lets the data plane survive management-plane and short Postgres outages.

## Build order (milestones)

M1 Core relay (generic SMTP provider, single path) → M2 Resilience (retry tiers, DLQ/DSN, 3-node HA, graceful drain) → M3 Providers + routing (Gmail/XOAUTH2, SES, M365, failover, rate limiting) → M4 Management plane (Admin API, config schema, hot reload, GUI) → M5 Packaging (Helm, compose, systemd, cert-manager, multi-arch). v2 deferred: direct-to-MX, MTA-STS/DANE, inbound SPF/DKIM verification, multi-tenancy/RBAC.

# Plan — deliverability / DNS health checks (+ alerting)

Adds domain **deliverability checks** to the management plane: resolve and grade
each relay domain's email-auth DNS (SPF, DKIM, DMARC) plus broader hygiene
records (MX, MTA-STS, BIMI, TLS-RPT), surface state + the **exact fix** for each
issue in the GUI, persist results for history/regression detection, and **alert**
(webhook + email) when a domain regresses.

The standout vs a generic "mail tester": NovaMail *generates* the DKIM keys and
*knows the route*, so it checks **correctness** (published key == signing key;
SPF authorizes the provider this domain actually relays through), not just
presence.

Two-plane rule preserved: all of this lives in the **Fastify Admin API +
React GUI** (management plane). The Go data-plane binaries gain nothing. DNS
health is **advisory** — it never gates the mail path (a misconfigured SPF does
not stop the relay; the upstream provider still authenticates the handoff).

In scope: SPF/DKIM/DMARC/MX/MTA-STS/BIMI/TLS-RPT, on-demand + periodic checks
with persisted history, regression alerting (webhook + email-via-self). Out of
scope: inbound SPF/DKIM *verification* of received mail (v2), DANE, sender-side
MTA-STS *enforcement* (v2) — we only *read* a domain's published MTA-STS here.

---

## 1. What's checked

Grouped in the UI so the essentials stay prominent and the rest reads as hygiene.

### Authentication (required for NovaMail's send path)

- **DKIM — authoritative match.** For each `dkim_keys` row (`domain`, `selector`,
  `public_key`, `rotation`), resolve `<selector>._domainkey.<domain>` TXT and
  compare its `p=` to `public_key`.
  - `rotation=active` → must be published **and** match. Missing/mismatch = error.
  - `rotation=retiring` → should still be published during overlap; missing = warning.
  - `rotation=revoked` → should be **removed**; still-present = warning.
  - Emits the exact expected record: `v=DKIM1; k=rsa; p=<public_key>`.
- **SPF — authorizes the route.** Resolve the domain's root TXT `v=spf1 …`. Map
  the provider the domain routes to (`routing_rules` → `providers.type`) to the
  mechanism it needs:
  | provider type | required mechanism |
  |---|---|
  | gmail | `include:_spf.google.com` |
  | ses | `include:amazonses.com` |
  | m365 | `include:spf.protection.outlook.com` |
  | smtp (generic) | can't auto-derive — recommend "authorize `<endpoint host>`", check syntax only |
  - Grade: present + includes required mechanism = ok; present but missing it =
    warning (with the corrected record as the fix); absent = error.
  - Also validate: single SPF record, syntactically valid, **≤10 DNS lookups**
    (common silent failure), ends in `-all`/`~all`.
  - Honest framing in UI: "authorizes NovaMail's route" — **not** "your whole SPF
    is correct." Never tell the user to remove includes we don't recognize.
- **DMARC.** Resolve `_dmarc.<domain>` TXT. Present? Parse `p=` →
  none/quarantine/reject. Warn on `p=none` (monitoring-only, not enforcing) and
  on missing `rua=` (no failure visibility). Note: true DMARC *alignment* needs
  aggregate-report analysis — we check the record + policy only, and say so.

### Hygiene & reporting (informational for a send-only domain)

- **MX** — resolve MX. A send-only domain needs none, but absent MX can hurt
  reputation / drop bounces+replies. Informational.
- **MTA-STS** — `_mta-sts.<domain>` TXT **and** an HTTPS fetch of
  `https://mta-sts.<domain>/.well-known/mta-sts.txt` (parse `mode=`). Inbound-TLS
  posture; informational. **Needs egress 443** (see §7 security).
- **BIMI** — `default._bimi.<domain>` TXT (`v=BIMI1; l=<svg>; a=<vmc>`). Requires
  enforcing DMARC as a precondition (cross-check). v1: validate record + that the
  logo/VMC URLs are well-formed; **defer fetching/validating the SVG+VMC** (SSRF
  surface, §7). Niche; informational.
- **TLS-RPT** — `_smtp._tls.<domain>` TXT (`v=TLSRPTv1; rua=…`). Reporting;
  informational.

Each non-OK result carries a **copy-paste fix** (the record to publish) — the
diagnosis is only useful if it hands over the remedy.

---

## 2. Architecture & placement

- New Admin API module `services/admin-api/src/dns.ts`: resolution
  (`node:dns/promises` `resolveTxt`/`resolveMx`), HTTP policy fetches
  (MTA-STS/BIMI) behind an SSRF guard, grading, and fix generation.
- Inputs come from existing config: `relay_domains` (which domains),
  `dkim_keys` (expected DKIM), `routing_rules` + `providers` (SPF route mapping).
- **On-demand** ("Check now") resolves live and returns; **periodic** writes
  results to Postgres for history + regression detection. Both in the management
  plane; periodic runs as an Admin API scheduled task (or a small management
  CronJob hitting the API) — **not** the Go maintenance CronJob.
- Advisory only: results never feed the data plane or block sending.

---

## 3. Schema (next free migrations, ≥0014)

- **0014 — DNS check results**
  - `domain_dns_checks(domain text, record text check (record in
    ('spf','dkim','dmarc','mx','mta_sts','bimi','tls_rpt')), selector text null,
    status text check (status in ('ok','warning','error','info')), found text,
    expected text, detail text, checked_at timestamptz default now(),
    primary key (domain, record, coalesce(selector,'')))` — current state.
  - `domain_dns_history(id bigint generated always as identity pk, domain text,
    record text, selector text null, status text, detail text, at timestamptz
    default now())` — append-only, drives the timeline + regression diff +
    debounce. Pruned by the maintenance retention sweep.
- **0015 — alert channels**
  - `alert_channels(id uuid pk, type text check (type in ('webhook','email')),
    target text, secret_ref text null, severity_threshold text default 'warning',
    events text[] default '{regression,recovery}', muted_domains text[] default
    '{}', enabled bool default true, created_at)`. Webhook URLs/tokens stored as
    `secret_ref` → existing **envelope-encrypted `secrets`** table, never plaintext.
  - `domain_alert_state(domain text, record text, last_alerted_status text,
    consecutive int default 0, updated_at, primary key (domain, record))` —
    edge-trigger + debounce bookkeeping.

---

## 4. API surface (Admin API)

- `GET  /api/deliverability` — all relay domains, rolled-up status + per-record
  summary (from `domain_dns_checks`).
- `GET  /api/deliverability/:domain` — full per-record detail + history.
- `POST /api/deliverability/:domain/check` — on-demand live re-check (also
  refreshes the persisted state). Auth-gated like the rest of the Admin API.
- `GET/POST/PUT/DELETE /api/alert-channels` — CRUD (generic resource pattern),
  secrets enveloped on write, never returned.
- `POST /api/alert-channels/:id/test` — send a synthetic alert (wire-test).

---

## 5. Periodic refresh + regression detection

- Scheduled every N hours (configurable; default 6). For each relay domain, run
  all checks, upsert `domain_dns_checks`, append `domain_dns_history`.
- **Regression detection** (drives alerting): compare new status to
  `domain_alert_state.last_alerted_status`.
  - **Edge-triggered**: alert only on a *transition* (healthy → warning/error),
    plus a separate `recovery` event back to healthy. Never re-fire while broken.
  - **Debounce**: require **2 consecutive** failing checks before firing (and 2
    healthy before "resolved") via `consecutive` — absorbs DNS TTL/propagation
    flap. Without this, alerts get muted by users.
  - On-demand checks **never** alert (the user is already looking).

---

## 6. Alerting

- **Channels** (pluggable):
  - **Webhook (primary)** — generic JSON POST; covers Slack/Teams/PagerDuty/
    Discord/custom. Versioned payload:
    ```json
    { "event": "deliverability.regression", "schemaVersion": 1,
      "domain": "acme.io", "record": "SPF", "severity": "warning",
      "was": "healthy", "now": "warning",
      "detail": "missing include:amazonses.com",
      "fix": "v=spf1 include:amazonses.com -all",
      "checkedAt": "…", "url": ".../deliverability/acme.io" }
    ```
    Retry with backoff (a few attempts) + log-on-failure; don't silently drop.
  - **Email — through NovaMail itself** via `publishRelayJob`. On-brand, but
    note the **chicken-and-egg**: an alert about a broken sending domain (or a
    degraded relay) may be affected — send from a known-good internal
    domain/provider, and treat webhook as the more reliable primary. State this
    in the UI.
- **Config**: `alert_channels` with per-channel severity threshold, event types,
  and muted domains. Secrets enveloped.
- **GUI**: a **Notifications** settings page — list/add channels, threshold,
  muted domains, and a **"Send test alert"** button.

---

## 7. Security & network

- **Egress**: Admin API needs outbound **53** (DNS) and **443** (MTA-STS/BIMI
  fetches, webhook POSTs). Update NetworkPolicy if egress is locked down.
- **SSRF guard (important)** — MTA-STS/BIMI fetch domain-controlled URLs, and
  webhook URLs are operator-supplied, so all outbound HTTP from the checker/
  alerter must: resolve the target first and **refuse RFC1918/loopback/link-
  local/ULA/metadata IPs**, disable redirects (or re-validate each hop), set tight
  timeouts + response-size caps, and (MTA-STS) only ever request the fixed
  `/.well-known/mta-sts.txt` path on `mta-sts.<domain>`. BIMI asset fetch is
  deferred partly for this reason.
- Webhook secrets/tokens: enveloped at rest, never logged, never returned by the
  API (mirror the existing `secrets` handling).

---

## 8. GUI

Hub-and-spoke.

**Hub — `Deliverability` page** (new top-level screen):
```
Deliverability                         last checked 4m ago   [ Re-check all ]
 ● 3 healthy   ▲ 2 warnings   ✕ 1 error

 DOMAIN        AUTH (req'd)         HYGIENE          STATUS     CHECKED
 example.com   DKIM✅ SPF✅ DMARC✅   MX✅ STS✅ …       ● healthy   4m   ▸
 acme.io       DKIM✅ SPF▲ DMARC✅   MX✅ BIMI–        ▲ warning   4m   ▾
   AUTHENTICATION (required)
     DKIM  nm1._domainkey   ✅ published & matches signing key
     SPF   authorizes route ▲ missing `include:amazonses.com`
           found: v=spf1 -all
           fix:   v=spf1 include:amazonses.com -all          [copy]
     DMARC _dmarc           ✅ p=reject, rua set
   HYGIENE & REPORTING                                        (collapsed)
     MX ✅   MTA-STS ✅   TLS-RPT ✅   BIMI – not set
   HISTORY  ✅✅✅✅▲▲   (SPF regressed ~2d ago)
```
- Per-record status + found vs expected + copy-paste fix + TTL; Authentication
  always-visible, Hygiene collapsed; history strip makes regressions visible;
  per-domain "Check now" + global "Re-check all".

**Spoke 1 — Dashboard tile**: "Deliverability — 3/5 OK · 2 issues →". Where a
silent regression gets noticed.

**Spoke 2 — Domain detail badge**: a health chip + "View deliverability →" on the
existing relay-domains edit view.

---

## 9. Caveats / honesty (carry into UI copy)

- SPF check = "authorizes NovaMail's route," not a global SPF audit.
- DMARC green = record + policy present, **not** proof of live alignment.
- DKIM is the one truly authoritative check (we hold the key).
- Propagation/TTL: always show `last_checked` + record TTL to defuse "but I just
  fixed it." Debounce alerts accordingly.
- MTA-STS/BIMI are receiving-side + HTTP-dependent — the heaviest, least
  send-relevant items; clearly labeled hygiene.

---

## 10. Phased delivery (one PR per phase, shipped through CI + verified on kw)

1. **Checker + on-demand GUI (immediately useful).** `dns.ts` for SPF/DKIM/DMARC
   (DKIM-match, SPF-route), `GET/POST /api/deliverability[/:domain[/check]]`,
   the Deliverability page with the per-domain card + copy-paste fixes. No
   persistence yet — live checks only.
2. **Hygiene records.** Add MX, TLS-RPT (DNS), MTA-STS + BIMI (HTTP behind the
   SSRF guard). Egress 443 + NetworkPolicy. Hygiene group in the card.
3. **Persistence + periodic + regression.** Migrations 0014, scheduled refresh,
   history timeline, dashboard tile, domain-detail badge, regression diff.
4. **Alerting.** Migration 0015, `alert_channels` CRUD + enveloped secrets,
   edge-triggered + debounced dispatch, webhook + email-via-self, Notifications
   settings page + test button.

Verification per phase: live-check a known-good and a deliberately-broken domain
on the cluster (e.g., a test domain with a wrong DKIM `p=`); confirm the fix
string is correct; for phase 4, use the test button + force a regression and
confirm a single debounced alert (not a flood) fires and a recovery clears it.

---

## 11. Open questions / future

- BIMI: validate the VMC certificate chain, or stop at record/URL syntax? (v1: syntax.)
- Additional channels later (Slack-native blocks, SMS) — the pluggable channel
  layer should make these additive.
- Should the periodic interval be global or per-domain? (Start global.)

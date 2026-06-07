import type { FastifyInstance } from "fastify";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { pool } from "./db.js";

// Deliverability checks (Phase 1): resolve and grade a relay domain's email-auth
// DNS — SPF, DKIM, DMARC — and return the exact record to publish for each issue.
// Because NovaMail generates the DKIM keys and knows the route, it checks DKIM
// *correctness* (published key == signing key) and SPF *route-authorization*
// (does SPF include the provider this domain relays through), not just presence.
// Advisory only: this never touches the data plane or gates sending.

export type CheckStatus = "ok" | "warning" | "error" | "info";

export interface RecordReport {
  record: "spf" | "dkim" | "dmarc" | "mx" | "mta_sts" | "bimi" | "tls_rpt";
  selector?: string;
  status: CheckStatus;
  found: string | null; // what's published (joined TXT), or null if absent
  expected?: string; // the correct value, when we can compute it
  detail: string; // human explanation
  fix?: string; // copy-paste record to publish
}

export interface DomainReport {
  domain: string;
  checkedAt: string;
  status: CheckStatus; // rollup = worst record
  records: RecordReport[];
}

// ── Pure grading (no I/O — unit tested) ───────────────────────────────────────

// providerMechanism maps a provider type to the SPF mechanism a sending domain
// must include to authorize that route. null = can't auto-derive (generic smtp).
export function providerMechanism(type: string): string | null {
  switch (type) {
    case "gmail":
      return "include:_spf.google.com";
    case "ses":
      return "include:amazonses.com";
    case "m365":
      return "include:spf.protection.outlook.com";
    default:
      return null; // smtp / unknown smarthost
  }
}

// extractTag pulls `tag=value` out of a `;`-separated record (DKIM/DMARC style),
// keeping the full value (which may itself contain `=`, e.g. base64 padding).
function extractTag(record: string, tag: string): string | null {
  for (const part of record.split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq).trim().toLowerCase() === tag.toLowerCase()) {
      return t.slice(eq + 1).trim();
    }
  }
  return null;
}

const stripWs = (s: string): string => s.replace(/\s+/g, "");

export function gradeDkim(
  published: string | null,
  expectedPublicKey: string,
  rotation: string,
  selector: string,
  domain: string,
): RecordReport {
  const host = `${selector}._domainkey.${domain}`;
  const expectedRecord = `v=DKIM1; k=rsa; p=${expectedPublicKey}`;
  if (!published) {
    if (rotation === "revoked") {
      return { record: "dkim", selector, status: "ok", found: null, detail: `Revoked selector ${selector} is correctly absent.` };
    }
    return {
      record: "dkim", selector, found: null,
      status: rotation === "active" ? "error" : "warning",
      detail: `No DKIM record at ${host}.`,
      expected: expectedRecord, fix: expectedRecord,
    };
  }
  if (rotation === "revoked") {
    return { record: "dkim", selector, status: "warning", found: published, detail: `Revoked selector ${selector} is still published — remove ${host}.` };
  }
  const publishedKey = extractTag(published, "p");
  if (publishedKey && stripWs(publishedKey) === stripWs(expectedPublicKey)) {
    return { record: "dkim", selector, status: "ok", found: published, detail: "Published key matches the signing key." };
  }
  return {
    record: "dkim", selector, found: published,
    status: rotation === "active" ? "error" : "warning",
    detail: `Published DKIM key does not match the signing key — update ${host}.`,
    expected: expectedRecord, fix: expectedRecord,
  };
}

function buildSpf(includes: string[]): string {
  return ["v=spf1", ...includes, "-all"].join(" ");
}

// mergeSpf inserts missing mechanisms just before the `all` token (or appends
// them + a `-all` if none), returning a corrected record for copy-paste.
function mergeSpf(existing: string, missing: string[]): string {
  const tokens = existing.trim().split(/\s+/);
  const allIdx = tokens.findIndex((t) => /^[-~?+]?all$/i.test(t));
  if (allIdx >= 0) tokens.splice(allIdx, 0, ...missing);
  else tokens.push(...missing, "-all");
  return tokens.join(" ");
}

export function gradeSpf(txtRecords: string[], requiredIncludes: string[]): RecordReport {
  const spfs = txtRecords.filter((r) => /^v=spf1\b/i.test(r.trim()));
  const found = spfs[0] ?? null;
  if (spfs.length === 0) {
    const rec = buildSpf(requiredIncludes);
    return { record: "spf", status: "error", found: null, detail: "No SPF record found.", expected: rec, fix: rec };
  }
  if (spfs.length > 1) {
    return { record: "spf", status: "error", found, detail: `Multiple SPF records (${spfs.length}) — only one is allowed; mail will fail SPF.` };
  }
  const spf = spfs[0];
  // Match mechanisms as exact tokens (not substrings) so `include:amazonses.com`
  // isn't satisfied by `include:amazonses.com.evil.example`.
  const tokens = spf.trim().split(/\s+/).map((t) => t.toLowerCase());
  const missing = requiredIncludes.filter((inc) => !tokens.includes(inc.toLowerCase()));
  if (missing.length > 0) {
    const fixed = mergeSpf(spf, missing);
    return { record: "spf", status: "warning", found, detail: `SPF does not authorize NovaMail's route — missing ${missing.join(", ")}.`, expected: fixed, fix: fixed };
  }
  if (!/[-~?+]all\b/i.test(spf)) {
    return { record: "spf", status: "warning", found, detail: "SPF has no `all` mechanism (e.g. `-all`/`~all`) — add one to set the default." };
  }
  if (requiredIncludes.length === 0) {
    return { record: "spf", status: "info", found, detail: "SPF present and valid. Generic smarthost route — can't auto-verify the include; ensure SPF authorizes your smarthost." };
  }
  return { record: "spf", status: "ok", found, detail: "SPF authorizes NovaMail's route." };
}

export function gradeDmarc(txtRecords: string[]): RecordReport {
  const recs = txtRecords.filter((r) => /^v=dmarc1\b/i.test(r.trim()));
  const recommended = "v=DMARC1; p=reject; rua=mailto:dmarc@<your-domain>; adkim=s; aspf=s";
  const found = recs[0] ?? null;
  if (recs.length === 0) {
    return { record: "dmarc", status: "error", found: null, detail: "No DMARC record at _dmarc — receivers have no policy to apply.", expected: recommended, fix: recommended };
  }
  const rec = recs[0];
  const p = (extractTag(rec, "p") ?? "").toLowerCase();
  const rua = extractTag(rec, "rua");
  if (p === "none") {
    return { record: "dmarc", status: "warning", found, detail: "DMARC policy is p=none (monitoring only, not enforcing) — move to quarantine/reject when ready." };
  }
  if (p !== "quarantine" && p !== "reject") {
    return { record: "dmarc", status: "warning", found, detail: `DMARC policy p=${p || "(missing)"} is not a valid enforcing policy.` };
  }
  if (!rua) {
    return { record: "dmarc", status: "warning", found, detail: `DMARC is enforcing (p=${p}) but has no rua= — you get no aggregate reports / failure visibility.` };
  }
  return { record: "dmarc", status: "ok", found, detail: `DMARC enforcing (p=${p}) with aggregate reporting.` };
}

// ── Hygiene records (receiving-side / reporting — informational for relay) ─────

export function gradeMx(exchanges: string[]): RecordReport {
  if (exchanges.length === 0) {
    return { record: "mx", status: "info", found: null, detail: "No MX — this domain can't receive bounces or replies. Not required for relay-only sending." };
  }
  return { record: "mx", status: "info", found: exchanges.join(", "), detail: `MX present (${exchanges.length} host${exchanges.length > 1 ? "s" : ""}).` };
}

export function gradeTlsRpt(txtRecords: string[]): RecordReport {
  const rec = txtRecords.find((r) => /^v=TLSRPTv1\b/i.test(r.trim())) ?? null;
  if (!rec) {
    return { record: "tls_rpt", status: "info", found: null, detail: "No TLS-RPT record — no reports of inbound TLS delivery failures (optional)." };
  }
  return { record: "tls_rpt", status: "info", found: rec, detail: "TLS-RPT present." };
}

// gradeMtaSts grades the _mta-sts TXT plus the fetched policy file (null if the
// fetch failed / was blocked). A TXT with no reachable policy is a real misconfig.
export function gradeMtaSts(txt: string | null, policy: string | null): RecordReport {
  if (!txt) {
    return { record: "mta_sts", status: "info", found: null, detail: "No MTA-STS record — inbound TLS isn't enforced via MTA-STS (optional, receiving-side)." };
  }
  if (!policy) {
    return { record: "mta_sts", status: "warning", found: txt, detail: "MTA-STS DNS record present but its policy file (https://mta-sts.<domain>/.well-known/mta-sts.txt) is unreachable or invalid." };
  }
  const mode = (policy.match(/mode:\s*(\w+)/i)?.[1] ?? "").toLowerCase();
  if (mode === "enforce") return { record: "mta_sts", status: "info", found: txt, detail: "MTA-STS enforcing." };
  if (mode === "testing") return { record: "mta_sts", status: "info", found: txt, detail: "MTA-STS in testing mode (not yet enforcing)." };
  return { record: "mta_sts", status: "warning", found: txt, detail: `MTA-STS policy mode=${mode || "(none)"} — not enforcing.` };
}

export function gradeBimi(txt: string | null, dmarcEnforcing: boolean): RecordReport {
  if (!txt) {
    return { record: "bimi", status: "info", found: null, detail: "No BIMI record (optional brand-logo feature)." };
  }
  if (!extractTag(txt, "l")) {
    return { record: "bimi", status: "warning", found: txt, detail: "BIMI record present but has no logo (l=) URL." };
  }
  if (!dmarcEnforcing) {
    return { record: "bimi", status: "warning", found: txt, detail: "BIMI needs an enforcing DMARC policy (quarantine/reject) before logos display." };
  }
  return { record: "bimi", status: "info", found: txt, detail: "BIMI present with a logo URL." };
}

// rollup = worst *actionable* status. "info" (e.g. a generic-smtp route we can't
// auto-verify, or an optional hygiene record) is non-problematic, so it folds
// into "ok" for the domain badge.
export function rollup(records: RecordReport[]): CheckStatus {
  if (records.some((r) => r.status === "error")) return "error";
  if (records.some((r) => r.status === "warning")) return "warning";
  return "ok";
}

// ── Resolution + orchestration (I/O) ──────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// mapLimit runs fn over items with bounded concurrency, so checking many relay
// domains doesn't fire an unbounded burst of DNS queries at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// resolveTxtSafe returns each TXT record as a single joined string. Any failure
// (NXDOMAIN/ENODATA/timeout) maps to "no record" rather than throwing — these
// checks are advisory and a re-check clears a transient resolver hiccup.
async function resolveTxtSafe(name: string): Promise<string[]> {
  try {
    const chunks = await withTimeout(dns.resolveTxt(name), 5000);
    return chunks.map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

async function resolveMxSafe(name: string): Promise<string[]> {
  try {
    const mx = await withTimeout(dns.resolveMx(name), 5000);
    return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch {
    return [];
  }
}

// isPrivateAddr blocks SSRF targets: loopback / RFC1918 / link-local (incl. the
// cloud metadata IP) / IPv6 ULA + mapped equivalents.
function isPrivateAddr(ip: string): boolean {
  if (isIP(ip) === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local + 169.254.169.254 metadata
    return false;
  }
  const a = ip.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (/^fe[89ab]/.test(a)) return true; // link-local fe80::/10 (fe80–febf)
  if (/^f[cd]/.test(a)) return true; // unique local fc00::/7
  if (a.startsWith("::ffff:")) return isPrivateAddr(a.slice(7)); // IPv4-mapped
  return false;
}

// hostnameRe bounds the domain to a plausible DNS name before it's interpolated
// into a fetch URL (relay_domains.domain is free text).
const hostnameRe = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;

// safeFetchText fetches a small text file over HTTPS for MTA-STS, with an SSRF
// guard: HTTPS only, resolved host must not be an internal IP, no redirects,
// bounded time + size. (Residual DNS-rebinding window is accepted — the target
// is a fixed well-known path and the impact is reading a public policy file.)
async function safeFetchText(url: string, maxBytes = 64 * 1024, timeoutMs = 5000): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !hostnameRe.test(u.hostname)) return null;
  try {
    const addrs = (await withTimeout(dns.lookup(u.hostname, { all: true }), timeoutMs)).map((a) => a.address);
    if (addrs.length === 0 || addrs.some(isPrivateAddr)) return null;
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return null;
    // Bounded read: stop as soon as we exceed maxBytes rather than buffering an
    // arbitrarily large (possibly hostile) response into memory.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

// routedProviderTypes approximates the Go routing precedence for SPF: the
// provider types this sender domain can route through (its sender-domain rule's
// chain, else all enabled providers).
async function routedProviderTypes(domain: string): Promise<string[]> {
  const { rows: ruleRows } = await pool.query<{ provider_chain: string[] }>(
    "select provider_chain from routing_rules where sender_domain = $1 and enabled order by priority",
    [domain],
  );
  const ids = ruleRows.flatMap((r) => r.provider_chain ?? []);
  const q = ids.length
    ? await pool.query<{ type: string }>("select distinct type from providers where id = any($1) and enabled", [ids])
    : await pool.query<{ type: string }>("select distinct type from providers where enabled");
  return q.rows.map((r) => r.type);
}

export async function checkDomain(domain: string): Promise<DomainReport> {
  const records: RecordReport[] = [];

  // DKIM — one record per configured key (NovaMail is the source of truth).
  const { rows: keys } = await pool.query<{ selector: string; public_key: string; rotation: string }>(
    "select selector, public_key, rotation from dkim_keys where domain = $1 and rotation in ('active','retiring','revoked')",
    [domain],
  );
  if (keys.length === 0) {
    records.push({ record: "dkim", status: "warning", found: null, detail: "No DKIM key configured in NovaMail for this domain." });
  }
  for (const k of keys) {
    const txts = await resolveTxtSafe(`${k.selector}._domainkey.${domain}`);
    records.push(gradeDkim(txts[0] ?? null, k.public_key, k.rotation, k.selector, domain));
  }

  // SPF — authorize the route's provider(s).
  const types = await routedProviderTypes(domain);
  const required = [...new Set(types.map(providerMechanism).filter((x): x is string => x !== null))];
  records.push(gradeSpf(await resolveTxtSafe(domain), required));

  // DMARC.
  const dmarcTxts = await resolveTxtSafe(`_dmarc.${domain}`);
  records.push(gradeDmarc(dmarcTxts));
  const dmarcEnforcing = dmarcTxts.some((r) => /p\s*=\s*(quarantine|reject)/i.test(r));

  // Hygiene & reporting (receiving-side / optional).
  records.push(gradeMx(await resolveMxSafe(domain)));
  records.push(gradeTlsRpt(await resolveTxtSafe(`_smtp._tls.${domain}`)));

  const stsTxt = (await resolveTxtSafe(`_mta-sts.${domain}`)).find((r) => /^v=STSv1\b/i.test(r.trim())) ?? null;
  const stsPolicy = stsTxt ? await safeFetchText(`https://mta-sts.${domain}/.well-known/mta-sts.txt`) : null;
  records.push(gradeMtaSts(stsTxt, stsPolicy));

  const bimiTxt = (await resolveTxtSafe(`default._bimi.${domain}`)).find((r) => /^v=BIMI1\b/i.test(r.trim())) ?? null;
  records.push(gradeBimi(bimiTxt, dmarcEnforcing));

  return { domain, checkedAt: new Date().toISOString(), status: rollup(records), records };
}

// ── Persistence + scheduler (Phase 3) ─────────────────────────────────────────

// persistCheck replaces a domain's cached per-record state and appends a rollup
// history row, in one transaction.
async function persistCheck(report: DomainReport): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM domain_dns_checks WHERE domain = $1", [report.domain]);
    for (const r of report.records) {
      await client.query(
        `INSERT INTO domain_dns_checks (domain,record,selector,status,found,expected,detail,fix,checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [report.domain, r.record, r.selector ?? "", r.status, r.found, r.expected ?? null, r.detail, r.fix ?? null, report.checkedAt],
      );
    }
    await client.query("INSERT INTO domain_dns_history (domain, status) VALUES ($1,$2)", [report.domain, report.status]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// readCachedMap rebuilds the latest persisted report per domain (empty Map if the
// table is missing/empty — callers fall back to live checks).
async function readCachedMap(): Promise<Map<string, DomainReport>> {
  const map = new Map<string, DomainReport>();
  const { rows } = await pool.query<{ domain: string; record: RecordReport["record"]; selector: string; status: CheckStatus; found: string | null; expected: string | null; detail: string | null; fix: string | null; checked_at: Date | string }>(
    "select domain,record,selector,status,found,expected,detail,fix,checked_at from domain_dns_checks order by domain",
  );
  for (const r of rows) {
    let rep = map.get(r.domain);
    if (!rep) {
      // checked_at may arrive as a Date or a string depending on the pg type
      // parser config — normalise via new Date().
      rep = { domain: r.domain, checkedAt: new Date(r.checked_at).toISOString(), status: "ok", records: [] };
      map.set(r.domain, rep);
    }
    rep.records.push({ record: r.record, selector: r.selector || undefined, status: r.status, found: r.found, expected: r.expected ?? undefined, detail: r.detail ?? "", fix: r.fix ?? undefined });
  }
  for (const rep of map.values()) rep.status = rollup(rep.records);
  return map;
}

// getAllReports returns cached results, live-filling + persisting any uncached
// relay domain — so the first load self-populates and a missing migration
// degrades to live checks instead of failing.
async function getAllReports(): Promise<DomainReport[]> {
  const { rows: domains } = await pool.query<{ domain: string }>("select domain from relay_domains order by domain");
  let cached: Map<string, DomainReport>;
  try {
    cached = await readCachedMap();
  } catch {
    cached = new Map();
  }
  return mapLimit(domains, 6, async (d) => {
    const c = cached.get(d.domain);
    if (c) return c;
    const live = await checkDomain(d.domain).catch((err): DomainReport => ({
      domain: d.domain, checkedAt: new Date().toISOString(), status: "error",
      records: [{ record: "spf", status: "error", found: null, detail: `check failed: ${String(err?.message ?? err)}` }],
    }));
    persistCheck(live).catch(() => {});
    return live;
  });
}

// refreshAll re-checks every relay domain and persists — the periodic job.
async function refreshAll(log: { error: (o: unknown, m?: string) => void }): Promise<void> {
  const { rows } = await pool.query<{ domain: string }>("select domain from relay_domains");
  await mapLimit(rows, 4, async (d) => {
    try {
      await persistCheck(await checkDomain(d.domain));
    } catch (err) {
      log.error({ err, domain: d.domain }, "deliverability refresh failed");
    }
  });
}

export function registerDeliverability(app: FastifyInstance): void {
  // Cached read of all relay domains (live-fills + persists any gaps).
  app.get("/api/deliverability", async () => getAllReports());

  // Lightweight summary for the dashboard tile.
  app.get("/api/deliverability/summary", async () => {
    const reports = await getAllReports();
    const counts = { ok: 0, warning: 0, error: 0 };
    let lastChecked: string | null = null;
    for (const r of reports) {
      counts[r.status === "error" ? "error" : r.status === "warning" ? "warning" : "ok"]++;
      if (!lastChecked || r.checkedAt > lastChecked) lastChecked = r.checkedAt;
    }
    return { total: reports.length, ...counts, lastChecked };
  });

  // Force a fresh re-check of all domains, persist, return ("re-check all").
  app.post("/api/deliverability/check", async () => {
    await refreshAll(app.log);
    return getAllReports();
  });

  // Force a fresh re-check of one domain ("Check now"). Restricted to a configured
  // relay domain so it can't resolve arbitrary names.
  app.post("/api/deliverability/:domain/check", async (req, reply) => {
    const domain = (req.params as { domain: string }).domain;
    const { rowCount } = await pool.query("select 1 from relay_domains where domain = $1", [domain]);
    if (!rowCount) return reply.code(404).send({ error: "unknown relay domain" });
    const report = await checkDomain(domain);
    persistCheck(report).catch((err) => app.log.error({ err, domain }, "persist check failed"));
    return report;
  });

  // Cached single-domain read (queries just this domain, not the whole table).
  app.get("/api/deliverability/:domain", async (req, reply) => {
    const domain = (req.params as { domain: string }).domain;
    const { rowCount } = await pool.query("select 1 from relay_domains where domain = $1", [domain]);
    if (!rowCount) return reply.code(404).send({ error: "unknown relay domain" });
    try {
      const { rows } = await pool.query<{ record: RecordReport["record"]; selector: string; status: CheckStatus; found: string | null; expected: string | null; detail: string | null; fix: string | null; checked_at: Date | string }>(
        "select record,selector,status,found,expected,detail,fix,checked_at from domain_dns_checks where domain = $1",
        [domain],
      );
      if (rows.length) {
        const records: RecordReport[] = rows.map((r) => ({ record: r.record, selector: r.selector || undefined, status: r.status, found: r.found, expected: r.expected ?? undefined, detail: r.detail ?? "", fix: r.fix ?? undefined }));
        return { domain, checkedAt: new Date(rows[0].checked_at).toISOString(), status: rollup(records), records } satisfies DomainReport;
      }
    } catch {
      /* fall through to a live check if the cache table is unavailable */
    }
    return checkDomain(domain);
  });

  // Periodic background refresh keeps the cache fresh (+ history for regressions).
  const parsed = Number(process.env.NOVAMAIL_DELIVERABILITY_INTERVAL_HOURS);
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
  const ms = hours * 3_600_000;
  setTimeout(() => refreshAll(app.log).catch(() => {}), 30_000).unref();
  setInterval(() => refreshAll(app.log).catch(() => {}), ms).unref();
  app.log.info({ intervalHours: hours }, "deliverability scheduler started");
}

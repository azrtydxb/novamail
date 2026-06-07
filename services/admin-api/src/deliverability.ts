import type { FastifyInstance } from "fastify";
import { promises as dns } from "node:dns";
import { pool } from "./db.js";

// Deliverability checks (Phase 1): resolve and grade a relay domain's email-auth
// DNS — SPF, DKIM, DMARC — and return the exact record to publish for each issue.
// Because NovaMail generates the DKIM keys and knows the route, it checks DKIM
// *correctness* (published key == signing key) and SPF *route-authorization*
// (does SPF include the provider this domain relays through), not just presence.
// Advisory only: this never touches the data plane or gates sending.

export type CheckStatus = "ok" | "warning" | "error" | "info";

export interface RecordReport {
  record: "spf" | "dkim" | "dmarc";
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

// rollup = worst *actionable* status. "info" (e.g. a generic-smtp route we can't
// auto-verify) is non-problematic, so it folds into "ok" for the domain badge.
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
  records.push(gradeDmarc(await resolveTxtSafe(`_dmarc.${domain}`)));

  return { domain, checkedAt: new Date().toISOString(), status: rollup(records), records };
}

export function registerDeliverability(app: FastifyInstance): void {
  // All relay domains, live (Phase 3 turns this into a cached read). Bounded
  // concurrency so a large domain list can't burst DNS.
  app.get("/api/deliverability", async () => {
    const { rows } = await pool.query<{ domain: string }>("select domain from relay_domains order by domain");
    return mapLimit(rows, 8, (r) =>
      checkDomain(r.domain).catch(
        (err): DomainReport => ({
          domain: r.domain,
          checkedAt: new Date().toISOString(),
          status: "error",
          records: [{ record: "spf", status: "error", found: null, detail: `check failed: ${String(err?.message ?? err)}` }],
        }),
      ),
    );
  });

  // Single domain, live — drives "Check now" + card expansion. Restricted to a
  // configured relay domain so the endpoint can't be used to resolve arbitrary
  // names.
  app.get("/api/deliverability/:domain", async (req, reply) => {
    const domain = (req.params as { domain: string }).domain;
    const { rowCount } = await pool.query("select 1 from relay_domains where domain = $1", [domain]);
    if (!rowCount) return reply.code(404).send({ error: "unknown relay domain" });
    return checkDomain(domain);
  });
}

import type { FastifyInstance } from "fastify";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { pool } from "./db.js";
import { encrypt, decrypt } from "./secrets.js";
import type { DomainReport, CheckStatus } from "./deliverability.js";

// Deliverability alerting (Phase 4). Webhook channels (Slack/Teams/PagerDuty/
// custom) fired on edge-triggered + debounced regressions/recoveries detected by
// the periodic checker. Webhook URLs are envelope-encrypted at rest.

const DEBOUNCE = 2; // consecutive identical checks before a transition fires
const SEVERITY: Record<string, number> = { ok: 0, info: 0, warning: 1, error: 2 };

interface Channel {
  id: string;
  name: string;
  secret: string | null;
  min_severity: string;
}

type Logger = { error: (o: unknown, m?: string) => void };

// ── SSRF-guarded webhook POST ─────────────────────────────────────────────────

function isPrivateAddr(ip: string): boolean {
  if (isIP(ip) === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    return false;
  }
  const a = ip.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (/^fe[89ab]/.test(a) || /^f[cd]/.test(a)) return true;
  if (a.startsWith("::ffff:")) return isPrivateAddr(a.slice(7));
  return false;
}

async function postWebhook(url: string, body: unknown): Promise<{ ok: boolean; detail: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, detail: "invalid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, detail: "URL must be http(s)" };
  try {
    const addrs = (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
    if (addrs.length === 0 || addrs.some(isPrivateAddr)) return { ok: false, detail: "refusing internal/unresolvable host" };
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

function payload(event: "regression" | "recovery", rep: DomainReport, was: string): Record<string, unknown> {
  return {
    event: `deliverability.${event}`,
    schemaVersion: 1,
    domain: rep.domain,
    was,
    now: rep.status,
    severity: rep.status,
    checkedAt: rep.checkedAt,
    issues: rep.records
      .filter((r) => r.status === "warning" || r.status === "error")
      .map((r) => ({ record: r.record, status: r.status, detail: r.detail, fix: r.fix ?? null })),
  };
}

// ── Edge-triggered + debounced transition detection ───────────────────────────

// evalTransition records the latest status and returns a confirmed transition
// (after DEBOUNCE consecutive identical checks) or null. The first time a domain
// is seen it just establishes a baseline — no alert.
async function evalTransition(domain: string, now: CheckStatus): Promise<{ event: "regression" | "recovery"; was: string } | null> {
  const { rows } = await pool.query<{ last_alerted_status: string; pending_status: string | null; consecutive: number }>(
    "select last_alerted_status, pending_status, consecutive from domain_alert_state where domain = $1",
    [domain],
  );
  if (rows.length === 0) {
    await pool.query("insert into domain_alert_state (domain, last_alerted_status, consecutive) values ($1,$2,0)", [domain, now]);
    return null; // baseline
  }
  const st = rows[0];
  if (now === st.last_alerted_status) {
    await pool.query("update domain_alert_state set pending_status=null, consecutive=0, updated_at=now() where domain=$1", [domain]);
    return null;
  }
  const consecutive = now === st.pending_status ? st.consecutive + 1 : 1;
  if (consecutive < DEBOUNCE) {
    await pool.query("update domain_alert_state set pending_status=$2, consecutive=$3, updated_at=now() where domain=$1", [domain, now, consecutive]);
    return null;
  }
  // Confirmed transition.
  await pool.query("update domain_alert_state set last_alerted_status=$2, pending_status=null, consecutive=0, updated_at=now() where domain=$1", [domain, now]);
  return { event: now === "ok" ? "recovery" : "regression", was: st.last_alerted_status };
}

async function loadChannels(): Promise<Channel[]> {
  const { rows } = await pool.query<Channel>("select id, name, secret, min_severity from alert_channels where enabled = true");
  return rows;
}

function shouldSend(ch: Channel, event: "regression" | "recovery", status: CheckStatus): boolean {
  if (event === "recovery") return true; // good news to everyone
  return (SEVERITY[status] ?? 0) >= (SEVERITY[ch.min_severity] ?? 1);
}

// dispatchAlerts is called by the periodic checker after a refresh — never on an
// on-demand check.
export async function dispatchAlerts(reports: DomainReport[], log: Logger): Promise<void> {
  let channels: Channel[];
  try {
    channels = await loadChannels();
  } catch {
    return; // alert tables not migrated yet
  }
  for (const rep of reports) {
    let transition: Awaited<ReturnType<typeof evalTransition>>;
    try {
      transition = await evalTransition(rep.domain, rep.status);
    } catch (err) {
      log.error({ err, domain: rep.domain }, "alert transition eval failed");
      continue;
    }
    if (!transition) continue;
    for (const ch of channels) {
      if (!ch.secret || !shouldSend(ch, transition.event, rep.status)) continue;
      const r = await postWebhook(decrypt(ch.secret), payload(transition.event, rep, transition.was));
      if (!r.ok) log.error({ channel: ch.name, domain: rep.domain, detail: r.detail }, "alert webhook failed");
    }
  }
}

// ── Channel CRUD + test ───────────────────────────────────────────────────────

export function registerAlerts(app: FastifyInstance): void {
  // List channels — never returns the webhook URL (only that one is set).
  app.get("/api/alert-channels", async () => {
    const { rows } = await pool.query<{ id: string; name: string; type: string; min_severity: string; enabled: boolean; secret: string | null; created_at: Date }>(
      "select id, name, type, min_severity, enabled, secret, created_at from alert_channels order by created_at",
    );
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, min_severity: r.min_severity, enabled: r.enabled, configured: !!r.secret, created_at: r.created_at }));
  });

  app.post("/api/alert-channels", async (req, reply) => {
    const b = req.body as { name?: string; url?: string; min_severity?: string };
    if (!b.name || !b.url) return reply.code(400).send({ error: "name and url required" });
    if (!/^https?:\/\//i.test(b.url)) return reply.code(400).send({ error: "url must be http(s)" });
    const sev = b.min_severity === "error" ? "error" : "warning";
    const { rows } = await pool.query(
      "insert into alert_channels (name, type, secret, min_severity) values ($1,'webhook',$2,$3) returning id, name, type, min_severity, enabled",
      [b.name, encrypt(b.url), sev],
    );
    return reply.code(201).send(rows[0]);
  });

  app.put("/api/alert-channels/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = req.body as { name?: string; url?: string; min_severity?: string; enabled?: boolean };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.name !== undefined) { vals.push(b.name); sets.push(`name=$${vals.length}`); }
    if (b.min_severity !== undefined) { vals.push(b.min_severity === "error" ? "error" : "warning"); sets.push(`min_severity=$${vals.length}`); }
    if (b.enabled !== undefined) { vals.push(b.enabled); sets.push(`enabled=$${vals.length}`); }
    if (b.url) {
      if (!/^https?:\/\//i.test(b.url)) return reply.code(400).send({ error: "url must be http(s)" });
      vals.push(encrypt(b.url)); sets.push(`secret=$${vals.length}`);
    }
    if (sets.length === 0) return reply.code(400).send({ error: "no writable fields" });
    vals.push(id);
    const { rows } = await pool.query(`update alert_channels set ${sets.join(",")} where id=$${vals.length} returning id, name, type, min_severity, enabled`, vals);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return rows[0];
  });

  app.delete("/api/alert-channels/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rowCount } = await pool.query("delete from alert_channels where id=$1", [id]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  // Send a synthetic alert through a channel (bypasses debounce) to verify wiring.
  app.post("/api/alert-channels/:id/test", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await pool.query<{ secret: string | null }>("select secret from alert_channels where id=$1", [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    if (!rows[0].secret) return reply.code(400).send({ error: "channel has no webhook URL" });
    const sample: DomainReport = {
      domain: "test.example", checkedAt: new Date().toISOString(), status: "warning",
      records: [{ record: "spf", status: "warning", found: "v=spf1 -all", detail: "Test alert from NovaMail.", fix: "v=spf1 include:amazonses.com -all" }],
    };
    const r = await postWebhook(decrypt(rows[0].secret), payload("regression", sample, "ok"));
    return reply.code(r.ok ? 200 : 502).send(r);
  });
}

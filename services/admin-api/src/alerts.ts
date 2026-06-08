import type { FastifyInstance } from "fastify";
import { promises as dns } from "node:dns";
import { randomUUID } from "node:crypto";
import { isIP as netIsIP } from "node:net";
import { pool } from "./db.js";
import { encrypt, decrypt } from "./secrets.js";
import { publishRelayJob } from "./bus.js";
import type { DomainReport, CheckStatus } from "./deliverability.js";

// Deliverability alerting (Phase 4). Channels — webhook (Slack/Teams/PagerDuty/
// custom) and email (delivered through the relay itself) — fired on edge-
// triggered + debounced regressions/recoveries from the periodic checker.
// Webhook URLs are envelope-encrypted at rest.

const DEBOUNCE = 2; // consecutive identical checks before a transition fires
const SEVERITY: Record<string, number> = { ok: 0, info: 0, warning: 1, error: 2 };

interface Channel {
  id: string;
  name: string;
  type: string;
  target: string | null;
  secret: string | null;
  min_severity: string;
}

type Logger = { error: (o: unknown, m?: string) => void };

// ── SSRF-guarded webhook POST ─────────────────────────────────────────────────

// validWebhookURL fully parses the URL (not just a regex prefix) and requires
// http(s), so an unparseable value like "http://" can't be stored.
export function validWebhookURL(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

export function isPrivateAddr(ip: string): boolean {
  if (netIsIP(ip) === 4) {
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

// ── Email via the relay itself ────────────────────────────────────────────────

// alertFrom reads the alert sender from the DB settings (Settings page). Postgres
// is the single source of truth for operational config — never env.
async function alertFrom(): Promise<string> {
  const { rows } = await pool.query("SELECT value#>>'{}' AS v FROM settings WHERE key='alert_from'");
  return (rows[0]?.v ?? "").trim();
}

// injectEmail submits an alert email through NovaMail's own relay path (body
// store + message row + relay job) — the same handoff ingress does, so no SMTP
// auth is needed. The alert sender (Settings → alert_from) must be a permitted
// relay sender.
async function injectEmail(to: string[], subject: string, text: string): Promise<{ ok: boolean; detail: string }> {
  const from = await alertFrom();
  if (!from) return { ok: false, detail: "alert sender not configured (set it in Settings)" };
  if (to.length === 0) return { ok: false, detail: "no recipient" };
  const id = randomUUID();
  const body = Buffer.from(
    `From: NovaMail Alerts <${from}>\r\n` +
      `To: ${to.join(", ")}\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `Message-ID: <${id}@novamail>\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n${text}\r\n`,
    "utf8",
  );
  const senderDomain = (from.split("@")[1] ?? "").toLowerCase();
  const recipientDomain = (to[0].split("@")[1] ?? "").toLowerCase();
  try {
    await pool.query("INSERT INTO message_bodies (id, body) VALUES ($1,$2)", [id, body]);
    await pool.query(
      "INSERT INTO messages (id, mail_from, rcpt_to, body_ref, body_backend, status, subject, size_bytes) VALUES ($1,$2,$3,$4,'pg','queued',$5,$6)",
      [id, from, to, id, subject, body.length],
    );
    const ok = await publishRelayJob({
      v: 1,
      messageId: id,
      bodyRef: { backend: "pg", key: id },
      envelope: { mailFrom: from, rcptTo: to },
      routingHints: { recipientDomain, senderDomain },
      attempt: 0,
      enqueuedAt: new Date().toISOString(),
    });
    return ok ? { ok: true, detail: "queued via relay" } : { ok: false, detail: "bus not connected" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

// ── Alert content ─────────────────────────────────────────────────────────────

function webhookPayload(event: "regression" | "recovery", rep: DomainReport, was: string): Record<string, unknown> {
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

function emailContent(event: "regression" | "recovery", rep: DomainReport, was: string): { subject: string; text: string } {
  if (event === "recovery") {
    return { subject: `[NovaMail] ${rep.domain} deliverability recovered`, text: `Deliverability for ${rep.domain} is healthy again (was ${was}).\n\nChecked at ${rep.checkedAt}.` };
  }
  const issues = rep.records
    .filter((r) => r.status === "warning" || r.status === "error")
    .map((r) => `  • ${r.record.toUpperCase()} [${r.status}]: ${r.detail}${r.fix ? `\n    fix: ${r.fix}` : ""}`)
    .join("\n");
  return {
    subject: `[NovaMail] ${rep.domain} deliverability ${rep.status} (was ${was})`,
    text: `Deliverability for ${rep.domain} regressed: ${was} → ${rep.status}.\n\nIssues:\n${issues}\n\nChecked at ${rep.checkedAt}.`,
  };
}

// ── Edge-triggered + debounced transition detection ───────────────────────────

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
  await pool.query("update domain_alert_state set last_alerted_status=$2, pending_status=null, consecutive=0, updated_at=now() where domain=$1", [domain, now]);
  return { event: now === "ok" ? "recovery" : "regression", was: st.last_alerted_status };
}

async function loadChannels(): Promise<Channel[]> {
  const { rows } = await pool.query<Channel>("select id, name, type, target, secret, min_severity from alert_channels where enabled = true");
  return rows;
}

export function shouldSend(ch: { min_severity: string }, event: "regression" | "recovery", status: CheckStatus): boolean {
  if (event === "recovery") return true;
  return (SEVERITY[status] ?? 0) >= (SEVERITY[ch.min_severity] ?? 1);
}

async function send(ch: Channel, event: "regression" | "recovery", rep: DomainReport, was: string): Promise<{ ok: boolean; detail: string }> {
  if (ch.type === "email") {
    if (!ch.target) return { ok: false, detail: "no recipient address" };
    const { subject, text } = emailContent(event, rep, was);
    return injectEmail(ch.target.split(",").map((s) => s.trim()).filter(Boolean), subject, text);
  }
  if (!ch.secret) return { ok: false, detail: "no webhook URL" };
  let url: string;
  try {
    url = decrypt(ch.secret);
  } catch {
    return { ok: false, detail: "webhook secret unreadable (corrupt or key mismatch)" };
  }
  return postWebhook(url, webhookPayload(event, rep, was));
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
  if (channels.length === 0) return;
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
      if (!shouldSend(ch, transition.event, rep.status)) continue;
      const r = await send(ch, transition.event, rep, transition.was);
      if (!r.ok) log.error({ channel: ch.name, domain: rep.domain, detail: r.detail }, "alert dispatch failed");
    }
  }
}

// ── Channel CRUD + test ───────────────────────────────────────────────────────

function maskTarget(ch: { type: string; target: string | null; secret: string | null }): boolean {
  return ch.type === "email" ? !!ch.target : !!ch.secret;
}

export function registerAlerts(app: FastifyInstance): void {
  // List channels — never returns the webhook URL (only that one is configured).
  app.get("/api/alert-channels", async () => {
    const { rows } = await pool.query<{ id: string; name: string; type: string; target: string | null; secret: string | null; min_severity: string; enabled: boolean; created_at: Date }>(
      "select id, name, type, target, secret, min_severity, enabled, created_at from alert_channels order by created_at",
    );
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, target: r.type === "email" ? r.target : null, min_severity: r.min_severity, enabled: r.enabled, configured: maskTarget(r), created_at: r.created_at }));
  });

  app.post("/api/alert-channels", async (req, reply) => {
    const b = req.body as { name?: string; type?: string; url?: string; target?: string; min_severity?: string };
    const type = b.type === "email" ? "email" : "webhook";
    if (!b.name) return reply.code(400).send({ error: "name required" });
    const sev = b.min_severity === "error" ? "error" : "warning";
    if (type === "webhook") {
      if (!b.url || !validWebhookURL(b.url)) return reply.code(400).send({ error: "valid http(s) webhook url required" });
      const { rows } = await pool.query("insert into alert_channels (name, type, secret, min_severity) values ($1,'webhook',$2,$3) returning id, name, type, min_severity, enabled", [b.name, encrypt(b.url), sev]);
      return reply.code(201).send(rows[0]);
    }
    if (!b.target) return reply.code(400).send({ error: "email target address(es) required" });
    const { rows } = await pool.query("insert into alert_channels (name, type, target, min_severity) values ($1,'email',$2,$3) returning id, name, type, min_severity, enabled", [b.name, b.target, sev]);
    return reply.code(201).send(rows[0]);
  });

  app.put("/api/alert-channels/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = req.body as { name?: string; url?: string; target?: string; min_severity?: string; enabled?: boolean };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.name !== undefined) { vals.push(b.name); sets.push(`name=$${vals.length}`); }
    if (b.min_severity !== undefined) { vals.push(b.min_severity === "error" ? "error" : "warning"); sets.push(`min_severity=$${vals.length}`); }
    if (b.enabled !== undefined) { vals.push(b.enabled); sets.push(`enabled=$${vals.length}`); }
    if (b.target !== undefined) { vals.push(b.target); sets.push(`target=$${vals.length}`); }
    if (b.url) {
      if (!validWebhookURL(b.url)) return reply.code(400).send({ error: "url must be http(s)" });
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
    const { rows } = await pool.query<Channel>("select id, name, type, target, secret, min_severity from alert_channels where id=$1", [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    const sample: DomainReport = {
      domain: "test.example", checkedAt: new Date().toISOString(), status: "warning",
      records: [{ record: "spf", status: "warning", found: "v=spf1 -all", detail: "Test alert from NovaMail.", fix: "v=spf1 include:amazonses.com -all" }],
    };
    const r = await send(rows[0], "regression", sample, "ok");
    return reply.code(r.ok ? 200 : 502).send(r);
  });
}

import type { FastifyInstance } from "fastify";
import { pool } from "./db.js";

// Derive the RabbitMQ management endpoint + credentials from AMQP_URL
// (amqp://user:pass@host:5672/). Management listens on 15672.
function mgmt() {
  const u = new URL(process.env.AMQP_URL ?? "amqp://guest:guest@localhost:5672/");
  return {
    base: `http://${u.hostname}:15672`,
    auth: "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64"),
  };
}

async function mgmtGet<T>(path: string): Promise<T | null> {
  const m = mgmt();
  try {
    const res = await fetch(`${m.base}${path}`, { headers: { authorization: m.auth }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface RmqQueue {
  name: string; messages: number; consumers: number; state?: string;
  message_stats?: { publish_details?: { rate: number }; deliver_get_details?: { rate: number }; ack_details?: { rate: number } };
}

function queueKind(name: string): "work" | "wait" | "dlq" {
  if (name.startsWith("wait.")) return "wait";
  if (name === "relay.dlq") return "dlq";
  return "work";
}

export async function getQueues() {
  const qs = (await mgmtGet<RmqQueue[]>("/api/queues")) ?? [];
  return qs
    .filter((q) => q.name.startsWith("relay.") || q.name.startsWith("wait."))
    .map((q) => {
      const kind = queueKind(q.name);
      const out = Math.round(q.message_stats?.deliver_get_details?.rate ?? q.message_stats?.ack_details?.rate ?? 0);
      const state = kind === "wait" ? "ttl" : kind === "dlq" ? (q.consumers > 0 ? "draining" : "idle") : (q.state ?? "running");
      return {
        name: q.name, kind, depth: q.messages ?? 0,
        in: Math.round(q.message_stats?.publish_details?.rate ?? 0), out,
        consumers: q.consumers ?? 0, state,
      };
    });
}

export async function getMetrics() {
  // 24h event counts by kind
  const counts = await pool.query<{ kind: string; n: string }>(
    "SELECT kind, count(*) n FROM message_events WHERE at > now() - interval '24 hours' GROUP BY kind",
  );
  const by: Record<string, number> = {};
  for (const r of counts.rows) by[r.kind] = Number(r.n);
  const relayed = by.relayed ?? 0, deferred = by.deferred ?? 0, bounced = (by.bounced ?? 0) + (by.failed ?? 0);
  const acceptRate = relayed + bounced > 0 ? (relayed / (relayed + bounced)) * 100 : 100;

  // hourly series (24 buckets) for relayed/deferred/bounced
  const series = await pool.query<{ h: number; kind: string; n: string }>(
    `SELECT extract(hour from at)::int h, kind, count(*) n
       FROM message_events WHERE at > now() - interval '24 hours'
       GROUP BY 1,2`,
  );
  const mk = () => Array.from({ length: 24 }, () => 0);
  const S = { relayed: mk(), deferred: mk(), bounced: mk(), queue: mk(), latency: mk() };
  for (const r of series.rows) {
    const arr = (S as Record<string, number[]>)[r.kind === "failed" ? "bounced" : r.kind];
    if (arr) arr[r.h] = (arr[r.h] ?? 0) + Number(r.n);
  }

  // per-provider relayed volume (24h)
  const pv = await pool.query<{ provider: string; n: string }>(
    "SELECT provider, count(*) n FROM message_events WHERE kind='relayed' AND provider IS NOT NULL AND at > now() - interval '24 hours' GROUP BY provider",
  );
  const providerVolume: Record<string, number> = {};
  for (const r of pv.rows) providerVolume[r.provider] = Number(r.n);

  // provider health + last-used: the most recent attempt per provider
  // (relayed ⇒ healthy, otherwise degraded). Real, not the enabled flag.
  const ph = await pool.query<{ provider: string; last: string; kind: string }>(
    `SELECT DISTINCT ON (provider) provider, at AS last, kind
       FROM message_events WHERE provider IS NOT NULL AND provider <> ''
       ORDER BY provider, at DESC`,
  );
  const providerHealth: Record<string, { lastUsed: string; status: string }> = {};
  for (const r of ph.rows) {
    providerHealth[r.provider] = { lastUsed: r.last, status: r.kind === "relayed" ? "healthy" : "degraded" };
  }

  // per-sender-domain message volume (24h), derived from MAIL FROM. Require an
  // '@' so the null sender (<>) and other address-less values don't pile into an
  // empty-string "domain".
  const dv = await pool.query<{ d: string; n: string }>(
    `SELECT lower(split_part(mail_from,'@',2)) d, count(*) n
       FROM messages WHERE created_at > now() - interval '24 hours' AND mail_from LIKE '%@_%'
       GROUP BY d`,
  );
  const domainVolume: Record<string, number> = {};
  for (const r of dv.rows) domainVolume[r.d] = Number(r.n);

  // dkimSigned: reflect whether DKIM signing is actually configured (an active
  // key exists) rather than asserting 100% unconditionally.
  const dk = await pool.query<{ n: string }>("SELECT count(*) n FROM dkim_keys WHERE rotation = 'active'");
  const dkimSigned = Number(dk.rows[0]?.n ?? 0) > 0 ? 100 : 0;

  // queue depth + cluster nodes from RabbitMQ management
  const queues = await getQueues();
  const queueDepth = queues.reduce((a, q) => a + q.depth, 0);
  S.queue[new Date().getUTCHours()] = queueDepth;

  const nodes = (await mgmtGet<Array<{ name: string; running: boolean }>>("/api/nodes")) ?? [];
  const server = {
    name: "relay-kw", version: "v1",
    nodes: nodes.map((n, i) => ({ id: n.name.replace(/^rabbit@/, ""), role: i === 0 ? "leader" : "follower", up: "—", state: n.running ? "healthy" : "down" })),
  };

  return {
    metrics: {
      relayed24h: relayed, deferred24h: deferred, bounced24h: bounced,
      // NOTE: send latency is exported as a Prometheus histogram
      // (novamail_delivery_send_seconds) for Grafana; we don't fabricate p50/p95
      // here. dkimSigned reflects whether DKIM signing is configured (active key).
      acceptRate: Math.round(acceptRate * 100) / 100, queueDepth, dkimSigned,
    },
    series: S,
    providerVolume,
    providerHealth,
    domainVolume,
    server,
  };
}

// purgeQueue empties a queue via the RabbitMQ management API.
async function purgeQueue(name: string): Promise<boolean> {
  const m = mgmt();
  try {
    const res = await fetch(`${m.base}/api/queues/%2F/${encodeURIComponent(name)}/contents`, {
      method: "DELETE",
      headers: { authorization: m.auth },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function registerTelemetry(app: FastifyInstance): void {
  app.get("/api/queues", async () => getQueues());
  app.get("/api/metrics", async () => getMetrics());
  app.post("/api/queues/:name/purge", async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!name.startsWith("relay.") && !name.startsWith("wait.")) {
      return reply.code(400).send({ error: "refusing to purge non-relay queue" });
    }
    const ok = await purgeQueue(name);
    return reply.code(ok ? 200 : 502).send({ purged: ok, queue: name });
  });
}

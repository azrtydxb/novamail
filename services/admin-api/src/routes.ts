import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { publishConfigChanged } from "./bus.js";
import { encrypt } from "./secrets.js";

// Generic config resource: which table, which config.changed slice, the
// writable columns, and the primary key. The Admin API validates that only
// whitelisted columns are written.
interface Resource {
  table: string;
  slice: string;
  cols: string[];
  pk: string;
}

const RESOURCES: Record<string, Resource> = {
  providers: { table: "providers", slice: "providers", pk: "id", cols: ["name", "type", "endpoint", "auth_mode", "enabled", "secret_ref"] },
  "routing-rules": { table: "routing_rules", slice: "routing_rules", pk: "id", cols: ["recipient_domain", "sender_domain", "provider_chain", "priority", "enabled"] },
  "relay-domains": { table: "relay_domains", slice: "relay_domains", pk: "domain", cols: ["domain", "enabled"] },
  "rate-limits": { table: "rate_limits", slice: "rate_limits", pk: "id", cols: ["direction", "scope", "scope_value", "per_second", "burst", "enabled"] },
  "relay-clients": { table: "relay_clients", slice: "relay_clients", pk: "id", cols: ["cidr", "description", "allowed_sender_domains", "enabled"] },
  "dkim-keys": { table: "dkim_keys", slice: "dkim_keys", pk: "id", cols: ["domain", "selector", "private_ref", "public_key", "rotation"] },
  "tls-policy": { table: "tls_policy", slice: "tls_policy", pk: "id", cols: ["min_version", "starttls_required", "provider_id"] },
};

function pick(body: Record<string, unknown>, cols: string[]): [string[], unknown[]] {
  const keys: string[] = [];
  const vals: unknown[] = [];
  for (const c of cols) {
    if (body[c] !== undefined) {
      keys.push(c);
      vals.push(body[c]);
    }
  }
  return [keys, vals];
}

export function registerRoutes(app: FastifyInstance): void {
  // Generic CRUD for each config resource.
  for (const [name, r] of Object.entries(RESOURCES)) {
    app.get(`/api/${name}`, async () => {
      const { rows } = await pool.query(`SELECT * FROM ${r.table} ORDER BY ${r.pk}`);
      return rows;
    });

    app.post(`/api/${name}`, async (req, reply) => {
      const [keys, vals] = pick(req.body as Record<string, unknown>, r.cols);
      if (keys.length === 0) return reply.code(400).send({ error: "no writable fields" });
      const ph = vals.map((_, i) => `$${i + 1}`).join(",");
      const { rows } = await pool.query(
        `INSERT INTO ${r.table} (${keys.join(",")}) VALUES (${ph}) RETURNING *`,
        vals,
      );
      await publishConfigChanged([r.slice]);
      return reply.code(201).send(rows[0]);
    });

    app.put(`/api/${name}/:id`, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const [keys, vals] = pick(req.body as Record<string, unknown>, r.cols);
      if (keys.length === 0) return reply.code(400).send({ error: "no writable fields" });
      const set = keys.map((k, i) => `${k}=$${i + 1}`).join(",");
      const { rows } = await pool.query(
        `UPDATE ${r.table} SET ${set} WHERE ${r.pk}=$${keys.length + 1} RETURNING *`,
        [...vals, id],
      );
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      await publishConfigChanged([r.slice]);
      return rows[0];
    });

    app.delete(`/api/${name}/:id`, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const { rowCount } = await pool.query(`DELETE FROM ${r.table} WHERE ${r.pk}=$1`, [id]);
      if (!rowCount) return reply.code(404).send({ error: "not found" });
      await publishConfigChanged([r.slice]);
      return reply.code(204).send();
    });
  }

  // Accounts: passwords are hashed here; the hash is never returned.
  app.get("/api/accounts", async () => {
    const { rows } = await pool.query(
      "SELECT id, username, allowed_sender_domains, ip_allowlist, enabled, created_at FROM accounts ORDER BY username",
    );
    return rows;
  });

  app.post("/api/accounts", async (req, reply) => {
    const b = req.body as { username?: string; password?: string; allowed_sender_domains?: string[]; ip_allowlist?: string[] };
    if (!b.username || !b.password) return reply.code(400).send({ error: "username and password required" });
    const hash = await bcrypt.hash(b.password, 10);
    const { rows } = await pool.query(
      `INSERT INTO accounts (username, password_hash, allowed_sender_domains, ip_allowlist)
       VALUES ($1,$2,$3,$4) RETURNING id, username, allowed_sender_domains, ip_allowlist`,
      [b.username, hash, b.allowed_sender_domains ?? [], b.ip_allowlist ?? []],
    );
    await publishConfigChanged(["accounts"]);
    return reply.code(201).send(rows[0]);
  });

  app.put("/api/accounts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = req.body as { allowed_sender_domains?: string[]; enabled?: boolean; password?: string };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.allowed_sender_domains !== undefined) { vals.push(b.allowed_sender_domains); sets.push(`allowed_sender_domains=$${vals.length}`); }
    if (b.enabled !== undefined) { vals.push(b.enabled); sets.push(`enabled=$${vals.length}`); }
    if (b.password) { vals.push(await bcrypt.hash(b.password, 10)); sets.push(`password_hash=$${vals.length}`); }
    if (sets.length === 0) return reply.code(400).send({ error: "no writable fields" });
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE accounts SET ${sets.join(",")} WHERE id=$${vals.length}
       RETURNING id, username, allowed_sender_domains, enabled`,
      vals,
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    await publishConfigChanged(["accounts"]);
    return rows[0];
  });

  app.delete("/api/accounts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rowCount } = await pool.query("DELETE FROM accounts WHERE id=$1", [id]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await publishConfigChanged(["accounts"]);
    return reply.code(204).send();
  });

  // Secrets: provider credentials / DKIM keys, envelope-encrypted at rest.
  // The plaintext is never returned or logged; only refs are listable.
  app.get("/api/secrets", async () => {
    const { rows } = await pool.query("SELECT ref, updated_at FROM secrets ORDER BY ref");
    return rows;
  });

  app.put("/api/secrets/:ref", async (req, reply) => {
    const ref = (req.params as { ref: string }).ref;
    const value = (req.body as { value?: unknown }).value;
    if (value === undefined) return reply.code(400).send({ error: "value required" });
    // value may be an object (e.g. {username,password}) or a raw string (DKIM PEM).
    const plaintext = typeof value === "string" ? value : JSON.stringify(value);
    let envelope: string;
    try {
      envelope = encrypt(plaintext);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
    await pool.query(
      `INSERT INTO secrets (ref, envelope, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (ref) DO UPDATE SET envelope=EXCLUDED.envelope, updated_at=now()`,
      [ref, envelope],
    );
    await publishConfigChanged(["providers", "dkim_keys"]);
    return reply.code(204).send();
  });

  app.delete("/api/secrets/:ref", async (req, reply) => {
    const ref = (req.params as { ref: string }).ref;
    const { rowCount } = await pool.query("DELETE FROM secrets WHERE ref=$1", [ref]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await publishConfigChanged(["providers", "dkim_keys"]);
    return reply.code(204).send();
  });

  // Suppression list (recipients we stop sending to).
  app.get("/api/suppressions", async () => {
    const { rows } = await pool.query("SELECT address, reason, source, created_at FROM suppressions ORDER BY created_at DESC");
    return rows;
  });
  app.post("/api/suppressions", async (req, reply) => {
    const b = req.body as { address?: string; reason?: string };
    if (!b.address) return reply.code(400).send({ error: "address required" });
    await pool.query(
      `INSERT INTO suppressions (address, reason, source) VALUES (lower($1),$2,'manual')
       ON CONFLICT (address) DO UPDATE SET reason=EXCLUDED.reason`,
      [b.address, b.reason ?? "manual"],
    );
    await publishConfigChanged(["suppressions"]);
    return reply.code(201).send({ address: b.address.toLowerCase() });
  });
  app.delete("/api/suppressions/:address", async (req, reply) => {
    const a = (req.params as { address: string }).address;
    const { rowCount } = await pool.query("DELETE FROM suppressions WHERE address=lower($1)", [a]);
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    await publishConfigChanged(["suppressions"]);
    return reply.code(204).send();
  });

  // Provider bounce/complaint feedback (Amazon SES via SNS; generic fallback).
  app.post("/api/feedback/:provider", async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const addrs: string[] = [];
    let reason = "hard_bounce";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = req.body as any;
    try {
      if (body?.Message !== undefined) {
        const msg = typeof body.Message === "string" ? JSON.parse(body.Message) : body.Message;
        if (msg.notificationType === "Complaint") {
          reason = "complaint";
          for (const r of msg.complaint?.complainedRecipients ?? []) addrs.push(r.emailAddress);
        } else if (msg.notificationType === "Bounce") {
          for (const r of msg.bounce?.bouncedRecipients ?? []) addrs.push(r.emailAddress);
        }
      } else if (Array.isArray(body?.addresses)) {
        addrs.push(...body.addresses);
        reason = body.reason ?? reason;
      }
    } catch {
      return reply.code(400).send({ error: "unparseable feedback" });
    }
    for (const a of addrs) {
      await pool.query(
        `INSERT INTO suppressions (address, reason, source) VALUES (lower($1),$2,$3)
         ON CONFLICT (address) DO UPDATE SET reason=EXCLUDED.reason`,
        [a, reason, provider],
      );
    }
    if (addrs.length) await publishConfigChanged(["suppressions"]);
    return { suppressed: addrs.length };
  });

  // Message tracing (read-only): list + per-message event timeline.
  app.get("/api/messages", async (req) => {
    const q = req.query as { status?: string; q?: string; limit?: string };
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`status=$${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(mail_from ILIKE $${params.length} OR array_to_string(rcpt_to,',') ILIKE $${params.length})`); }
    params.push(Math.min(Number(q.limit) || 100, 500));
    const { rows } = await pool.query(
      `SELECT id, mail_from, rcpt_to, status, attempts, subject, size_bytes, created_at, updated_at FROM messages
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  });

  app.get("/api/messages/:id/events", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { rows } = await pool.query(
      "SELECT kind, provider, detail, at FROM message_events WHERE message_id=$1 ORDER BY at",
      [id],
    );
    if (rows.length === 0) {
      const m = await pool.query("SELECT 1 FROM messages WHERE id=$1", [id]);
      if (m.rowCount === 0) return reply.code(404).send({ error: "not found" });
    }
    return rows;
  });
}

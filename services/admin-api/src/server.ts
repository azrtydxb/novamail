import Fastify from "fastify";
import bcrypt from "bcryptjs";
import { ping, pool } from "./db.js";
import { connect, ready } from "./bus.js";
import { registerRoutes } from "./routes.js";
import { registerTelemetry } from "./telemetry.js";
import { bearerOperator, type OperatorClaims } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: string;
    operator?: OperatorClaims;
  }
}

const app = Fastify({ logger: true });

// Auth: accept either a valid operator bearer token (GUI login) OR the static
// admin API key (automation). Login + provider feedback are unauthenticated.
const apiKey = process.env.NOVAMAIL_ADMIN_API_KEY;
const OPEN_PATHS = new Set(["/healthz", "/readyz", "/api/auth/login"]);
app.addHook("onRequest", async (req, reply) => {
  if (OPEN_PATHS.has(req.url.split("?")[0]) || req.url.startsWith("/api/feedback/")) return;
  const op = bearerOperator(req.headers["authorization"]);
  if (op) {
    req.operator = op;
    req.actor = op.username;
    return;
  }
  if (!apiKey) {
    req.actor = "anonymous";
    return;
  }
  if (req.headers["x-api-key"] === apiKey) {
    req.actor = "api-key";
    return;
  }
  return reply.code(401).send({ error: "unauthorized" });
});

// Audit: record every successful mutating request with the resolved actor.
app.addHook("onResponse", async (req, reply) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  if (reply.statusCode >= 400) return;
  if (req.url.startsWith("/api/auth/login")) return; // never log credentials
  try {
    await pool.query("INSERT INTO audit_log (actor, action, target) VALUES ($1,$2,$3)", [
      req.actor ?? "unknown",
      `${method} ${req.routeOptions?.url ?? req.url}`,
      req.url.split("?")[0],
    ]);
  } catch {
    /* audit must never break the request */
  }
});

app.get("/healthz", async () => ({ status: "ok" }));
app.get("/readyz", async (_req, reply) => {
  try {
    await ping();
  } catch {
    return reply.code(503).send({ status: "postgres unreachable" });
  }
  if (!ready()) return reply.code(503).send({ status: "bus not connected" });
  return { status: "ready" };
});

registerRoutes(app);
registerTelemetry(app);

const port = Number(process.env.PORT ?? 3000);

// Seed a bootstrap admin operator if none exist, so the GUI login works on a
// fresh install. Password from NOVAMAIL_ADMIN_BOOTSTRAP_PASSWORD (default 'admin').
async function seedAdmin() {
  try {
    const { rows } = await pool.query("SELECT count(*)::int n FROM operators");
    if (rows[0].n > 0) return;
    const pw = process.env.NOVAMAIL_ADMIN_BOOTSTRAP_PASSWORD || "admin";
    const hash = await bcrypt.hash(pw, 10);
    await pool.query("INSERT INTO operators (username, password_hash, role) VALUES ('admin',$1,'admin')", [hash]);
    app.log.warn("seeded bootstrap operator 'admin' — change the password");
  } catch (err) {
    app.log.error({ err }, "seed admin operator failed");
  }
}

async function main() {
  try {
    await connect();
  } catch (err) {
    app.log.error({ err }, "config bus connect failed; will publish best-effort");
  }
  await seedAdmin();
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

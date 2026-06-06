import Fastify from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { ping, pool } from "./db.js";
import { connect, ready } from "./bus.js";
import { registerRoutes } from "./routes.js";
import { registerTelemetry } from "./telemetry.js";
import { auth } from "./betterauth.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: string;
    role?: string; // "admin" (read/write) | "user" (read-only viewer) | undefined (api-key)
  }
}

const app = Fastify({ logger: true });

// Mount better-auth (email+password, sessions, admin plugin) at /api/auth/*.
// Fastify parses JSON bodies, so re-serialize for the Fetch-style handler.
app.route({
  method: ["GET", "POST"],
  url: "/api/auth/*",
  async handler(request, reply) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const req = new Request(url.toString(), {
      method: request.method,
      headers: fromNodeHeaders(request.headers),
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    const response = await auth.handler(req);
    reply.status(response.status);
    const setCookies = response.headers.getSetCookie?.() ?? [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
    });
    if (setCookies.length) reply.header("set-cookie", setCookies);
    return reply.send(response.body ? await response.text() : null);
  },
});

// Auth + authorization for the rest of /api. A valid operator session (cookie)
// OR the static x-api-key (automation). Operators with a non-admin role are
// read-only; the API key has full access. /api/auth/* and health are open.
const apiKey = process.env.NOVAMAIL_ADMIN_API_KEY;
// Health is open. Login/session traffic is validated by better-auth itself.
// NOTE: /api/feedback/* is NOT open — it requires the API key (provider
// bounce/complaint webhooks must be delivered via an authenticated forwarder),
// preventing anonymous suppression-list injection.
const OPEN_PATHS = new Set(["/healthz", "/readyz"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (OPEN_PATHS.has(path) || path.startsWith("/api/auth/")) return;

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (session?.user) {
    req.actor = session.user.email;
    // role is an additional field from the admin plugin
    req.role = (session.user as { role?: string }).role ?? "user";
    if (req.role !== "admin" && MUTATING.has(req.method.toUpperCase())) {
      return reply.code(403).send({ error: "read-only: your operator role cannot make changes" });
    }
    return;
  }
  // Fail closed: a request with no valid session must present the API key.
  // (If no API key is configured, only session auth is accepted — never anonymous.)
  if (apiKey && req.headers["x-api-key"] === apiKey) {
    req.actor = "api-key";
    return;
  }
  return reply.code(401).send({ error: "unauthorized" });
});

// Audit every successful mutating config request (not auth/session traffic).
app.addHook("onResponse", async (req, reply) => {
  if (!MUTATING.has(req.method.toUpperCase())) return;
  if (reply.statusCode >= 400) return;
  if (req.url.startsWith("/api/auth/")) return;
  try {
    await pool.query("INSERT INTO audit_log (actor, action, target) VALUES ($1,$2,$3)", [
      req.actor ?? "unknown",
      `${req.method.toUpperCase()} ${req.routeOptions?.url ?? req.url}`,
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

// Seed a bootstrap admin operator if none exist (email + password via
// better-auth, then promote to the admin role). Configurable via env.
async function seedAdmin() {
  try {
    const { rows } = await pool.query('SELECT count(*)::int n FROM "user"');
    if (rows[0].n > 0) return;
    const email = process.env.NOVAMAIL_ADMIN_BOOTSTRAP_EMAIL || "admin@novamail.local";
    const password = process.env.NOVAMAIL_ADMIN_BOOTSTRAP_PASSWORD || "novamail-admin";
    await auth.api.signUpEmail({ body: { email, password, name: "admin" } });
    await pool.query("UPDATE \"user\" SET role='admin' WHERE email=$1", [email]);
    app.log.warn(`seeded bootstrap operator ${email} (role admin) — change the password`);
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

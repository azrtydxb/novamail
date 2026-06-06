import Fastify from "fastify";
import { ping } from "./db.js";
import { connect, ready } from "./bus.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: true });

// API-key auth (the GUI is the only client). If NOVAMAIL_ADMIN_API_KEY is unset
// the API is open (local dev only).
const apiKey = process.env.NOVAMAIL_ADMIN_API_KEY;
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/healthz" || req.url === "/readyz") return;
  if (!apiKey) return;
  if (req.headers["x-api-key"] !== apiKey) {
    return reply.code(401).send({ error: "unauthorized" });
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

const port = Number(process.env.PORT ?? 3000);

async function main() {
  try {
    await connect();
  } catch (err) {
    app.log.error({ err }, "config bus connect failed; will publish best-effort");
  }
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

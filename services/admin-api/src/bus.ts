import amqp from "amqplib";
import { readFileSync, existsSync } from "node:fs";
import { nextEpoch } from "./db.js";

const CONFIG_EXCHANGE = "config.changed";
const WORK_EXCHANGE = "relay.work";

let chan: amqp.Channel | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// busTLS builds amqplib socket options for amqps:// from the mounted CA (+ client
// cert for mutual TLS). Returns undefined for plaintext amqp:// or no CA.
function busTLS(): Record<string, unknown> | undefined {
  const url = process.env.AMQP_URL ?? "";
  if (!url.startsWith("amqps://")) return undefined;
  const dir = process.env.NOVAMAIL_AMQP_TLS_DIR || "/etc/novamail/amqptls";
  const ca = `${dir}/ca.crt`, cert = `${dir}/tls.crt`, key = `${dir}/tls.key`;
  if (!existsSync(ca)) return undefined;
  return {
    ca: [readFileSync(ca)],
    cert: existsSync(cert) ? readFileSync(cert) : undefined,
    key: existsSync(key) ? readFileSync(key) : undefined,
    servername: process.env.NOVAMAIL_AMQP_SERVERNAME || "nova-bus",
  };
}

// scheduleReconnect re-dials with capped backoff (amqplib does not auto-reconnect),
// so a RabbitMQ restart doesn't permanently sever the publisher.
function scheduleReconnect(delayMs = 1000): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => scheduleReconnect(Math.min(delayMs * 2, 30000)));
  }, delayMs);
}

// connect establishes the publisher channel and asserts the fanout exchange, and
// re-establishes it on connection loss (close/error → backoff reconnect).
export async function connect(): Promise<void> {
  try {
    const conn = await amqp.connect(process.env.AMQP_URL!, busTLS());
    const ch = await conn.createChannel();
    await ch.assertExchange(CONFIG_EXCHANGE, "fanout", { durable: true });
    chan = ch;
    conn.on("error", () => { /* surfaced via 'close'; avoid unhandled 'error' */ });
    conn.on("close", () => {
      chan = null;
      scheduleReconnect();
    });
  } catch (err) {
    chan = null;
    scheduleReconnect();
    throw err; // let the caller log the initial failure; reconnect continues in the background
  }
}

export function ready(): boolean {
  return chan !== null;
}

// publishConfigChanged fans out a config.changed event so the data plane
// hot-reloads the affected slices. Mirrors api/config-changed.schema.json.
export async function publishConfigChanged(slices: string[]): Promise<void> {
  if (!chan) return; // bus down: data plane re-reads on its own reconnect
  const epoch = await nextEpoch();
  const event = {
    v: 1,
    epoch,
    slices,
    changedAt: new Date().toISOString(),
  };
  chan.publish(CONFIG_EXCHANGE, "", Buffer.from(JSON.stringify(event)), {
    contentType: "application/json",
  });
}

// publishRelayJob re-injects a job into the work exchange (operator requeue),
// keyed on recipient domain so it lands in the right per-domain queue.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishRelayJob(job: any): Promise<boolean> {
  if (!chan) return false;
  const key = job?.routingHints?.recipientDomain ?? "";
  return chan.publish(WORK_EXCHANGE, key, Buffer.from(JSON.stringify(job)), {
    contentType: "application/json",
  });
}

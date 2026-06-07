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
  const opts: Record<string, unknown> = {
    ca: [readFileSync(ca)],
    servername: process.env.NOVAMAIL_AMQP_SERVERNAME || "nova-bus",
  };
  // Only present a client cert when BOTH halves exist — a cert without its key
  // (or vice-versa) would make tls.connect throw.
  if (existsSync(cert) && existsSync(key)) {
    opts.cert = readFileSync(cert);
    opts.key = readFileSync(key);
  }
  return opts;
}

// failures drives the reconnect backoff; incremented on each failed dial and
// reset to 0 on a successful connect.
let failures = 0;

// scheduleReconnect re-dials with capped exponential backoff (amqplib does not
// auto-reconnect). connect() itself escalates `failures` + reschedules on
// failure, so the timer callback just ignores the rejection.
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delayMs = Math.min(1000 * 2 ** failures, 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => { /* connect() already escalated + rescheduled */ });
  }, delayMs);
}

// connect establishes the publisher channel and asserts the fanout exchange, and
// re-establishes it on loss of the connection OR the channel (close/error →
// backoff reconnect).
export async function connect(): Promise<void> {
  try {
    const conn = await amqp.connect(process.env.AMQP_URL!, busTLS());
    const ch = await conn.createChannel();
    await ch.assertExchange(CONFIG_EXCHANGE, "fanout", { durable: true });
    chan = ch;
    failures = 0;
    // A channel can close independently of the connection (e.g. a protocol
    // exception) — treat either the same: drop chan and re-dial. Guard on
    // chan === ch so a stale handler from a previous generation can't clobber a
    // newer channel.
    const onLost = () => {
      if (chan === ch) {
        chan = null;
        // If only the channel died, tear the connection down too so we don't
        // leak it across the re-dial (closing an already-closing conn is a no-op).
        conn.close().catch(() => {});
        scheduleReconnect();
      }
    };
    conn.on("error", () => { /* avoid unhandled 'error'; 'close' drives reconnect */ });
    conn.on("close", onLost);
    ch.on("error", () => { /* avoid unhandled 'error' */ });
    ch.on("close", onLost);
  } catch (err) {
    chan = null;
    failures++;
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

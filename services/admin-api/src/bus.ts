import amqp from "amqplib";
import { nextEpoch } from "./db.js";

const CONFIG_EXCHANGE = "config.changed";

let chan: amqp.Channel | null = null;

// connect establishes the publisher channel and asserts the fanout exchange.
export async function connect(): Promise<void> {
  const conn = await amqp.connect(process.env.AMQP_URL!);
  chan = await conn.createChannel();
  await chan.assertExchange(CONFIG_EXCHANGE, "fanout", { durable: true });
  conn.on("close", () => {
    chan = null;
  });
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

import pg from "pg";

// Single pool over the same Postgres the data plane reads. The Admin API owns
// writes to the operational-config tables (single source of truth).
export const pool = new pg.Pool({
  connectionString: process.env.DSN,
  max: 10,
});

export async function ping(): Promise<void> {
  await pool.query("select 1");
}

// nextEpoch returns a monotonic config epoch for config.changed events.
export async function nextEpoch(): Promise<number> {
  const r = await pool.query<{ nextval: string }>("select nextval('config_epoch_seq') as nextval");
  return Number(r.rows[0].nextval);
}

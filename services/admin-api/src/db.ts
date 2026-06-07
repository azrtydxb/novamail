import pg from "pg";
import { readFileSync, existsSync } from "node:fs";

// Postgres mutual TLS: when the CNPG CA + app client cert are mounted (verify-full
// + client auth), node-pg needs an explicit ssl object (it does not read
// sslcert/sslkey/sslrootcert file paths from the DSN the way libpq/pgx do).
// Falls back to no-TLS (in-cluster trusted net / dev) when the files are absent.
const PGTLS = process.env.NOVAMAIL_PGTLS_DIR || "/etc/novamail/pgtls";
function pgSSL(): pg.PoolConfig["ssl"] {
  const ca = `${PGTLS}/ca.crt`, cert = `${PGTLS}/tls.crt`, key = `${PGTLS}/tls.key`;
  if (!existsSync(ca)) return undefined;
  return {
    ca: readFileSync(ca),
    cert: existsSync(cert) ? readFileSync(cert) : undefined,
    key: existsSync(key) ? readFileSync(key) : undefined,
    rejectUnauthorized: true,
    // verify-full: the CNPG server cert SANs include the -rw/-ro service names.
    servername: process.env.NOVAMAIL_PG_HOST || "novamail-pg-rw",
  };
}

// Single pool over the same Postgres the data plane reads. The Admin API owns
// writes to the operational-config tables (single source of truth).
export const pool = new pg.Pool({
  connectionString: process.env.DSN,
  ssl: pgSSL(),
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

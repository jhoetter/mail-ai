// DB client wrapper. Owns the pg.Pool and exposes a typed Drizzle
// instance. This is the *only* file in mail-ai that opens Postgres
// connections (enforced by scripts/check-architecture.mjs).

import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DbConfig {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  readonly max?: number;
}

export function createPool(cfg: DbConfig): Pool {
  const opts: PoolConfig = {};
  if (cfg.connectionString) opts.connectionString = cfg.connectionString;
  if (cfg.host) opts.host = cfg.host;
  if (cfg.port) opts.port = cfg.port;
  if (cfg.user) opts.user = cfg.user;
  if (cfg.password) opts.password = cfg.password;
  if (cfg.database) opts.database = cfg.database;
  if (cfg.max) opts.max = cfg.max;
  return new Pool(opts);
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

// Run a callback inside a transaction with `mailai.tenant_id` GUC set so
// row-level security policies match. The Postgres role used by mail-ai
// in production should NOT be a superuser, so RLS actually applies.
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (db: Database, raw: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('mailai.tenant_id', $1, true)", [tenantId]);
    const tx = drizzle(client, { schema });
    const result = await fn(tx, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

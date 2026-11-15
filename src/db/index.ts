import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Config } from "../config.js";
export interface Db {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
pg.types.setTypeParser(20, Number);
export function postgresDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  const wrap = (client: pg.Pool | pg.PoolClient): Db => ({
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => ({ rows: (await client.query<T>(sql, params)).rows }),
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const result = await fn(wrap(c));
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  });
  return wrap(pool);
}
export function pgliteDb(dataDir?: string): Db {
  const client = new PGlite({
    dataDir,
    extensions: { pg_trgm },
    parsers: { 20: Number },
  });
  const wrap = (c: Pick<PGlite, "query">): Db => ({
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => ({ rows: (await c.query<T>(sql, params)).rows }),
    tx: (fn) => client.transaction((t) => fn(wrap(t))),
    close: () => client.close(),
  });
  return wrap(client);
}
export const openDb = (
  config: Pick<Config, "DATABASE_URL" | "PGLITE_DIR">,
): Db =>
  config.DATABASE_URL
    ? postgresDb(config.DATABASE_URL)
    : pgliteDb(config.PGLITE_DIR);

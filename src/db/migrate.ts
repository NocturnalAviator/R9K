import { readdir, readFile } from "node:fs/promises";
import type { Db } from "./index.js";
export async function migrate(db: Db): Promise<void> {
  // Schema metadata is global; application data is always chat-scoped.
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const dir = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    await db.tx(async (tx) => {
      await tx.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
      if (
        (
          await tx.query("SELECT name FROM schema_migrations WHERE name=$1", [
            name,
          ])
        ).rows.length
      )
        return;
      const sql = await readFile(new URL(name, dir), "utf8");
      for (const statement of sql.split(";").filter((s) => s.trim()))
        await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    });
  }
}

import { readConfig } from "../config.js";
import { openDb } from "./index.js";
import { migrate } from "./migrate.js";
const db = openDb(readConfig());
try {
  await migrate(db);
} finally {
  await db.close();
}

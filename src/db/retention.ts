import type { Db } from "./index.js";
import { parseSettings } from "../settings/schema.js";
import { purgeRemoved } from "./privacy.js";
// Each statement changes at most 500 rows and commits independently.
async function batch(
  db: Db,
  table: string,
  chatId: number,
  predicate: string,
  params: unknown[],
  update?: string,
): Promise<void> {
  let count: number;
  do {
    const result = await db.query(
      `${update ? `UPDATE ${table} SET ${update}` : `DELETE FROM ${table}`} WHERE chat_id=$1 AND ctid IN (SELECT ctid FROM ${table} WHERE chat_id=$1 AND (${predicate}) LIMIT 500) RETURNING 1`,
      [chatId, ...params],
    );
    count = result.rows.length;
  } while (count === 500);
}
export async function clearExpiredText(
  db: Db,
  chatId: number,
  now: Date,
): Promise<void> {
  const row = (
    await db.query<{ settings: unknown }>(
      "SELECT settings FROM chats WHERE chat_id=$1",
      [chatId],
    )
  ).rows[0];
  if (!row) return;
  const s = parseSettings(row.settings);
  await batch(
    db,
    "messages",
    chatId,
    "created_at<=$2 AND (raw_text IS NOT NULL OR normalized_text IS NOT NULL)",
    [new Date(+now - Math.min(s.memorySeconds ?? Infinity, 90 * 86400) * 1000)],
    "raw_text=NULL,normalized_text=NULL",
  );
}
export async function retainChat(
  db: Db,
  chatId: number,
  now: Date,
): Promise<void> {
  const row = (
    await db.query<{ settings: unknown }>(
      "SELECT settings FROM chats WHERE chat_id=$1",
      [chatId],
    )
  ).rows[0];
  if (!row) return;
  const s = parseSettings(row.settings);
  await clearExpiredText(db, chatId, now);
  if (s.memorySeconds !== null)
    await batch(db, "fingerprints", chatId, "created_at<=$2", [
      new Date(+now - s.memorySeconds * 1000),
    ]);
  await batch(
    db,
    "messages",
    chatId,
    "raw_text IS NULL AND normalized_text IS NULL AND NOT EXISTS (SELECT 1 FROM fingerprints f WHERE f.chat_id=$1 AND f.message_id=messages.message_id)",
    [],
  );
  for (const [table, column, seconds] of [
    ["actions", "created_at", 90 * 86400],
    ["stats_weekly", "week_start", 26 * 7 * 86400],
    ["score_events", "created_at", 26 * 7 * 86400],
    ["album_actions", "created_at", 86400],
    ["chains", "last_at", Math.max(s.chainWindowSeconds, 86400)],
    ["sticker_state", "updated_at", 30 * 86400],
  ] as const)
    await batch(db, table, chatId, `${column}<$2`, [
      new Date(+now - seconds * 1000),
    ]);
}
export async function sweepExpiredText(db: Db, now: Date): Promise<void> {
  const chats = await db.query<{ chat_id: number }>(
    "SELECT chat_id FROM chats",
  );
  for (const { chat_id } of chats.rows) await retainChat(db, chat_id, now);
  await purgeRemoved(db, now);
}

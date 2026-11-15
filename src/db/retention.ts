import type { Db } from "./index.js";
import { parseSettings } from "../settings/schema.js";
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
  const seconds = Math.min(
    parseSettings(row.settings).memorySeconds ?? Infinity,
    90 * 86400,
  );
  await db.query(
    `UPDATE messages SET raw_text=NULL,normalized_text=NULL
 WHERE chat_id=$1 AND created_at<=$2 AND (raw_text IS NOT NULL OR normalized_text IS NOT NULL)`,
    [chatId, new Date(now.getTime() - seconds * 1000)],
  );
}
// Enumerate only the chat directory; each message mutation is chat-scoped.
export async function sweepExpiredText(db: Db, now: Date): Promise<void> {
  const chats = await db.query<{ chat_id: number }>(
    "SELECT chat_id FROM chats",
  );
  for (const chat of chats.rows) await clearExpiredText(db, chat.chat_id, now);
}

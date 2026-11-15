import type { Db } from "./index.js";
export async function forget(
  db: Db,
  chatId: number,
  userId: number,
  now: Date,
): Promise<Record<string, number>> {
  return db.tx(async (tx) => {
    await tx.query("SELECT chat_id FROM chats WHERE chat_id=$1 FOR UPDATE", [
      chatId,
    ]);
    const counts: Record<string, number> = {};
    counts.texts = (
      await tx.query(
        "UPDATE messages SET raw_text=NULL,normalized_text=NULL WHERE chat_id=$1 AND user_id=$2 AND (raw_text IS NOT NULL OR normalized_text IS NOT NULL) RETURNING message_id",
        [chatId, userId],
      )
    ).rows.length;
    for (const table of [
      "users",
      "stats",
      "stats_weekly",
      "score_events",
      "sticker_state",
      "album_actions",
      "managed_chats",
    ])
      counts[table] = (
        await tx.query(
          `DELETE FROM ${table} WHERE chat_id=$1 AND user_id=$2 RETURNING user_id`,
          [chatId, userId],
        )
      ).rows.length;
    counts.chains = (
      await tx.query(
        `DELETE FROM chains WHERE chat_id=$1 AND (users @> $2::jsonb OR message_id IN (SELECT message_id FROM messages WHERE chat_id=$1 AND user_id=$3)) RETURNING message_id`,
        [chatId, JSON.stringify([userId]), userId],
      )
    ).rows.length;
    // Do not create a new association with unrelated chats during a private request.
    const known =
      Object.values(counts).some((n) => n > 0) ||
      (
        await tx.query(
          "SELECT user_id FROM messages WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
          [chatId, userId],
        )
      ).rows.length > 0 ||
      (
        await tx.query(
          "SELECT user_id FROM strikes WHERE chat_id=$1 AND user_id=$2 LIMIT 1",
          [chatId, userId],
        )
      ).rows.length > 0;
    if (known)
      await tx.query(
        `INSERT INTO actions(chat_id,user_id,message_id,action,rule,detail,created_at) VALUES($1,$2,0,'forget','forget',$3,$4)`,
        [chatId, userId, JSON.stringify(counts), now],
      );
    return counts;
  });
}
export async function purgeRemoved(db: Db, now: Date): Promise<void> {
  const chats = await db.query<{ chat_id: number }>(
    "SELECT chat_id FROM chats",
  );
  for (const { chat_id } of chats.rows)
    await db.query("DELETE FROM chats WHERE chat_id=$1 AND removed_at<$2", [
      chat_id,
      new Date(+now - 7 * 86400000),
    ]);
}

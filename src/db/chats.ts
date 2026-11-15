import type { Db } from "./index.js";
import { relaxed } from "../settings/presets.js";
import { parseSettings, type Settings } from "../settings/schema.js";
export interface Rights {
  admin: boolean;
  deleteMessages: boolean;
  restrictMembers: boolean;
}
export interface ChatRow {
  title: string;
  settings: Settings;
  rights: Rights;
  removed: boolean;
}
export async function saveChat(
  db: Db,
  chat: { id: number; type: string; title?: string },
  rights: Rights,
  now: Date,
  removed = false,
): Promise<void> {
  await db.query(
    `INSERT INTO chats(chat_id,type,title,settings,bot_rights,joined_at,removed_at)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chat_id) DO UPDATE SET
 type=$2,title=$3,bot_rights=$5,removed_at=$7`,
    [
      chat.id,
      chat.type,
      chat.title ?? null,
      JSON.stringify(relaxed),
      JSON.stringify(rights),
      now,
      removed ? now : null,
    ],
  );
}
export async function loadChat(
  db: Db,
  id: number,
): Promise<ChatRow | undefined> {
  const row = (
    await db.query<{
      title: string | null;
      settings: unknown;
      bot_rights: Rights;
      removed_at: Date | null;
    }>(
      "SELECT title,settings,bot_rights,removed_at FROM chats WHERE chat_id=$1",
      [id],
    )
  ).rows[0];
  return row
    ? {
        title: row.title ?? "This chat",
        settings: parseSettings(row.settings),
        rights: row.bot_rights,
        removed: row.removed_at !== null,
      }
    : undefined;
}
export async function migrateChat(
  db: Db,
  oldId: number,
  newId: number,
): Promise<void> {
  await db.tx(async (tx) => {
    // Telegram may deliver the new membership event before the migration message.
    const existing = (
      await tx.query("SELECT chat_id FROM chats WHERE chat_id=$1", [oldId])
    ).rows.length;
    if (!existing) return;
    const destination = (
      await tx.query("SELECT chat_id FROM messages WHERE chat_id=$1 LIMIT 1", [
        newId,
      ])
    ).rows.length;
    if (destination)
      throw new Error("Migration destination already has messages");
    await tx.query("DELETE FROM chats WHERE chat_id=$1", [newId]);
    await tx.query(
      "UPDATE chats SET chat_id=$2,type='supergroup' WHERE chat_id=$1",
      [oldId, newId],
    );
  });
}

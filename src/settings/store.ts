import { isDeepStrictEqual } from "node:util";
import type { Db } from "../db/index.js";
import { parseSettings, settingsSchema, type Settings } from "./schema.js";
import { presets } from "./presets.js";

export function presetName(settings: Settings): string {
  // Allow-phrases survive preset changes, so they do not make a chat "Custom".
  for (const [name, preset] of Object.entries(presets)) {
    if (
      isDeepStrictEqual(
        { ...settings, allowPhrases: [] },
        { ...preset, allowPhrases: [] },
      )
    )
      return name[0]!.toUpperCase() + name.slice(1);
  }
  return "Custom";
}

// All menu writes lock the same chat row as the engine, including concurrent admins.
export async function changeSettings(
  db: Db,
  chatId: number,
  userId: number,
  messageId: number,
  now: Date,
  key: string,
  change: (current: Settings) => Settings,
): Promise<void> {
  await db.tx(async (tx) => {
    const row = (
      await tx.query<{ settings: unknown }>(
        "SELECT settings FROM chats WHERE chat_id=$1 FOR UPDATE",
        [chatId],
      )
    ).rows[0];
    if (!row) throw new Error("Unknown settings chat");
    const old = parseSettings(row.settings);
    const candidate = change(structuredClone(old));
    const next = settingsSchema.parse(candidate);
    // The storage reader intentionally repairs invalid fields. Writes must not silently repair them.
    if (
      !isDeepStrictEqual(candidate, next) ||
      next.allowPhrases.length > 50 ||
      next.allowPhrases.some((p) => !p.trim() || [...p].length > 200)
    )
      throw new Error("Invalid settings change");
    await tx.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
      chatId,
      JSON.stringify(next),
    ]);
    const value = (s: Settings): unknown =>
      key
        .split(".")
        .reduce<unknown>(
          (v, part) =>
            v && typeof v === "object"
              ? (v as Record<string, unknown>)[part]
              : undefined,
          s,
        );
    await tx.query(
      "INSERT INTO actions(chat_id,user_id,message_id,action,rule,detail,created_at) VALUES($1,$2,$3,'settings_change',$4,$5,$6)",
      [
        chatId,
        userId,
        messageId,
        key,
        JSON.stringify({
          key,
          old: key === "preset" ? old : value(old),
          new: key === "preset" ? next : value(next),
        }),
        now,
      ],
    );
  });
}

export async function resetStrikes(
  db: Db,
  chatId: number,
  userId: number,
  messageId: number,
  now: Date,
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query("SELECT chat_id FROM chats WHERE chat_id=$1 FOR UPDATE", [
      chatId,
    ]);
    await tx.query("DELETE FROM strikes WHERE chat_id=$1", [chatId]);
    await tx.query(
      "INSERT INTO actions(chat_id,user_id,message_id,action,rule,detail,created_at) VALUES($1,$2,$3,'reset_strikes','admin','{}',$4)",
      [chatId, userId, messageId, now],
    );
  });
}

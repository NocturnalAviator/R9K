import type { Db } from "../db/index.js";
import {
  normalize,
  fingerprintText,
  type Entity,
} from "../detect/normalize.js";
import type { Settings } from "../settings/schema.js";
import { recordStrike, type Verdict } from "./strikes.js";
export interface MessageInput {
  chatId: number;
  settings: Settings;
  messageId: number;
  userId: number;
  text: string;
  entities?: readonly Entity[];
  isEdit: boolean;
  userIsAdmin: boolean;
  canMute: boolean;
  mediaGroupId?: string;
}
export async function processMessage(
  db: Db,
  input: MessageInput,
  now: Date,
): Promise<Verdict> {
  const { chatId, messageId, userId, settings: s } = input;
  return db.tx(async (tx) => {
    // Serialize decisions even when callers do not use the polling runner.
    await tx.query("SELECT chat_id FROM chats WHERE chat_id=$1 FOR UPDATE", [
      chatId,
    ]);
    const normalized = normalize(input.text, input.entities);
    if (
      (input.userIsAdmin && s.exemptAdmins) ||
      !normalized ||
      s.allowPhrases.some((p) => normalize(p) === normalized)
    )
      return { action: "none" };
    const hash = fingerprintText(normalized);
    const match = (
      await tx.query<{ message_id: number; created_at: Date }>(
        `
   SELECT message_id,created_at FROM fingerprints
   WHERE chat_id=$1 AND kind='text' AND hash=$2 AND message_id<>$3
   AND ($4::timestamptz IS NULL OR created_at>$4)
   ORDER BY created_at,message_id LIMIT 1`,
        [
          chatId,
          hash,
          messageId,
          s.memorySeconds === null
            ? null
            : new Date(now.getTime() - s.memorySeconds * 1000),
        ],
      )
    ).rows[0];
    await tx.query(
      `INSERT INTO messages(chat_id,message_id,user_id,raw_text,normalized_text,media_group_id,created_at,edited_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(chat_id,message_id) DO UPDATE SET raw_text=$4,normalized_text=$5,edited_at=$8,media_group_id=$6`,
      [
        chatId,
        messageId,
        userId,
        input.text,
        normalized,
        input.mediaGroupId ?? null,
        now,
        input.isEdit ? now : null,
      ],
    );
    await tx.query(
      "DELETE FROM fingerprints WHERE chat_id=$1 AND message_id=$2",
      [chatId, messageId],
    );
    if (match && input.isEdit) {
      const last = (
        await tx.query<{ matched_message_id: number }>(
          "SELECT matched_message_id FROM actions WHERE chat_id=$1 AND message_id=$2 ORDER BY id DESC LIMIT 1",
          [chatId, messageId],
        )
      ).rows[0];
      if (last?.matched_message_id === match.message_id)
        return { action: "none" };
    }
    await tx.query(
      `INSERT INTO stats(chat_id,user_id,originals,repeats) VALUES($1,$2,$3,$4)
   ON CONFLICT(chat_id,user_id) DO UPDATE SET originals=stats.originals+$3,repeats=stats.repeats+$4`,
      [chatId, userId, match ? 0 : 1, match ? 1 : 0],
    );
    if (!match) {
      await tx.query(
        `INSERT INTO fingerprints(chat_id,kind,hash,message_id,user_id,created_at)
    SELECT chat_id,'text',$3,message_id,user_id,created_at FROM messages WHERE chat_id=$1 AND message_id=$2`,
        [chatId, messageId, hash],
      );
      return { action: "none" };
    }
    const verdict: Verdict = {
      ...(await recordStrike(tx, chatId, userId, now, s, input.canMute)),
      rule: "exact_text",
      matchedMessageId: match.message_id,
      matchedAt: match.created_at,
    };
    await tx.query(
      `INSERT INTO actions(chat_id,user_id,message_id,action,rule,matched_message_id,detail,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        chatId,
        userId,
        messageId,
        verdict.action,
        verdict.rule,
        match.message_id,
        JSON.stringify(verdict),
        now,
      ],
    );
    return verdict;
  });
}

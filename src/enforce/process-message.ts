import type { Db } from "../db/index.js";
import {
  normalize,
  fingerprintText,
  type Entity,
} from "../detect/normalize.js";
import { extractLinks } from "../detect/links.js";
import { stepSticker, type StickerState } from "../detect/stickers.js";
import { lowEffortRule } from "../detect/low-effort.js";
import type { Settings } from "../settings/schema.js";
import { recordStrike, type Verdict } from "./strikes.js";
import { score } from "../stats/scores.js";
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
  kind?: string;
  mediaId?: string;
  stickerId?: string;
  isReply?: boolean;
  forwardOrigin?: { type: string; chatId?: number; messageId?: number };
}
interface Match extends Record<string, unknown> {
  message_id: number;
  user_id: number;
  created_at: Date;
  similarity?: number;
}
export async function processMessage(
  db: Db,
  input: MessageInput,
  now: Date,
): Promise<Verdict> {
  const { chatId, messageId, userId, settings: s } = input;
  return db.tx(async (tx) => {
    await tx.query("SELECT chat_id FROM chats WHERE chat_id=$1 FOR UPDATE", [
      chatId,
    ]);
    async function audit(v: Verdict): Promise<Verdict> {
      await tx.query(
        `INSERT INTO actions(chat_id,user_id,message_id,action,rule,matched_message_id,detail,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          chatId,
          userId,
          messageId,
          v.action,
          v.rule,
          v.matchedMessageId ?? null,
          JSON.stringify(v),
          now,
        ],
      );
      return v;
    }
    // Every non-sticker breaks this user's run, including exempt or empty messages.
    if (!input.stickerId)
      await tx.query(
        `UPDATE sticker_state SET state=jsonb_set(state,'{run}','0'),updated_at=$3 WHERE chat_id=$1 AND user_id=$2`,
        [chatId, userId, now],
      );
    const normalized = normalize(input.text, input.entities);
    if (
      (input.userIsAdmin && s.exemptAdmins) ||
      (normalized && s.allowPhrases.some((p) => normalize(p) === normalized))
    )
      return { action: "none" };
    if (input.stickerId) {
      if (input.isEdit) return { action: "none" };
      const previous = (
        await tx.query<{ state: StickerState }>(
          "SELECT state FROM sticker_state WHERE chat_id=$1 AND user_id=$2",
          [chatId, userId],
        )
      ).rows[0]?.state;
      const result = stepSticker(previous, input.stickerId, now, s.stickers);
      await tx.query(
        "INSERT INTO sticker_state(chat_id,user_id,state,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET state=$3,updated_at=$4",
        [chatId, userId, JSON.stringify(result.state), now],
      );
      return result.rule
        ? audit({ action: "delete_nostrike", rule: result.rule })
        : { action: "none" };
    }
    const prior = (
      await tx.query<{ classification: string | null }>(
        "SELECT classification FROM messages WHERE chat_id=$1 AND message_id=$2",
        [chatId, messageId],
      )
    ).rows[0];
    const stats = (classification: string | null) =>
      score(tx, chatId, userId, messageId, classification, now);
    const lowRule =
      !input.mediaId && (!input.kind || input.kind === "text") && input.text
        ? lowEffortRule(
            input.text,
            normalized,
            input.isReply ?? false,
            s.lowEffort,
          )
        : undefined;
    if (lowRule) {
      await stats(null);
      await tx.query(
        "DELETE FROM messages WHERE chat_id=$1 AND message_id=$2",
        [chatId, messageId],
      );
      return audit({ action: "delete_nostrike", rule: lowRule });
    }
    const links = extractLinks(input.text, input.entities);
    const exact =
      s.detectLinks && links.urls.length
        ? normalize(links.withoutLinks, [])
        : normalized;
    const fingerprints: {
      kind: string;
      hash: string;
      enabled: boolean;
      rule: string;
    }[] = [];
    const add = (kind: string, value: string, enabled: boolean, rule = kind) =>
      fingerprints.push({ kind, hash: fingerprintText(value), enabled, rule });
    const origin = input.forwardOrigin;
    if (
      origin &&
      ["channel", "chat"].includes(origin.type) &&
      origin.chatId !== undefined &&
      origin.messageId !== undefined
    )
      add(
        "forward",
        JSON.stringify([origin.type, origin.chatId, origin.messageId]),
        s.detectForwards,
      );
    if (input.mediaId) add("media", input.mediaId, s.detectMedia);
    if (exact)
      add(
        "text",
        s.detectLinks && links.urls.length
          ? JSON.stringify([exact, links.urls])
          : exact,
        true,
        "exact_text",
      );
    for (const url of links.urls) add("link", url, s.detectLinks);
    if (!fingerprints.length) {
      if (prior) {
        await stats(null);
        await tx.query(
          "DELETE FROM messages WHERE chat_id=$1 AND message_id=$2",
          [chatId, messageId],
        );
      }
      return { action: "none" };
    }
    const cutoff =
      s.memorySeconds === null ? null : new Date(+now - s.memorySeconds * 1000);
    let match: Match | undefined;
    let rule: string | undefined;
    for (const fp of fingerprints.filter((f) => f.enabled)) {
      match = (
        await tx.query<Match>(
          `SELECT message_id,user_id,created_at FROM fingerprints
        WHERE chat_id=$1 AND kind=$2 AND hash=$3 AND message_id<>$4
        AND ($5::timestamptz IS NULL OR created_at>$5) ORDER BY created_at,message_id LIMIT 1`,
          [chatId, fp.kind, fp.hash, messageId, cutoff],
        )
      ).rows[0];
      if (match) {
        rule = fp.rule;
        break;
      }
    }
    if (
      !match &&
      s.detectNearText &&
      [...normalized].length >= s.minFuzzyLength &&
      normalized
    ) {
      // SET LOCAL cannot bind parameters; validate before interpolation. The % predicate uses the GIN index.
      const threshold = s.nearTextThreshold;
      if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.95)
        throw Error("Invalid similarity threshold");
      await tx.query(`SET LOCAL pg_trgm.similarity_threshold = ${threshold}`);
      match = (
        await tx.query<Match>(
          `SELECT m.message_id,m.user_id,m.created_at,similarity(m.normalized_text,$2) AS similarity FROM messages m
        WHERE m.chat_id=$1 AND m.message_id<>$3 AND m.normalized_text % $2
        AND ($4::timestamptz IS NULL OR m.created_at>$4)
        AND EXISTS (SELECT 1 FROM fingerprints f WHERE f.chat_id=$1 AND f.message_id=m.message_id AND f.kind='text')
        ORDER BY similarity DESC,m.created_at,m.message_id LIMIT 1`,
          [chatId, normalized, messageId, cutoff],
        )
      ).rows[0];
      if (match) rule = "near_text";
    }
    const classification = match ? "repeat" : "original";

    await tx.query(
      `INSERT INTO messages(chat_id,message_id,user_id,raw_text,normalized_text,media_group_id,kind,created_at,edited_at,classification)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(chat_id,message_id) DO UPDATE
      SET raw_text=$4,normalized_text=$5,media_group_id=$6,kind=$7,edited_at=$9,classification=$10`,
      [
        chatId,
        messageId,
        userId,
        input.text,
        normalized,
        input.mediaGroupId ?? null,
        input.kind ?? "text",
        now,
        input.isEdit ? now : null,
        classification,
      ],
    );
    await tx.query(
      "DELETE FROM fingerprints WHERE chat_id=$1 AND message_id=$2",
      [chatId, messageId],
    );
    if (!match) {
      await stats("original");
      for (const fp of fingerprints)
        await tx.query(
          `INSERT INTO fingerprints(chat_id,kind,hash,message_id,user_id,created_at)
        SELECT chat_id,$3,$4,message_id,user_id,created_at FROM messages WHERE chat_id=$1 AND message_id=$2`,
          [chatId, messageId, fp.kind, fp.hash],
        );
      return { action: "none" };
    }
    if (input.isEdit && prior?.classification === "repeat") {
      const last = (
        await tx.query<{ matched_message_id: number }>(
          "SELECT matched_message_id FROM actions WHERE chat_id=$1 AND message_id=$2 ORDER BY id DESC LIMIT 1",
          [chatId, messageId],
        )
      ).rows[0];
      if (last?.matched_message_id === match.message_id)
        return { action: "none" };
    }
    const details = {
      rule,
      matchedMessageId: match.message_id,
      matchedAt: match.created_at,
      ...(match.similarity === undefined
        ? {}
        : { similarity: match.similarity }),
    };
    if (input.mediaGroupId) {
      const album = (
        await tx.query<{ verdict: Verdict }>(
          "SELECT verdict FROM album_actions WHERE chat_id=$1 AND user_id=$2 AND media_group_id=$3",
          [chatId, userId, input.mediaGroupId],
        )
      ).rows[0];
      if (album) {
        await stats(null);
        return audit({
          ...details,
          action: ["mute", "delete", "delete_nostrike"].includes(
            album.verdict.action,
          )
            ? "delete_nostrike"
            : "none",
          silent: true,
        });
      }
    }
    let verdict: Verdict | undefined;
    if (s.chainMode !== "off" && rule !== "near_text") {
      const saved = (
        await tx.query<{
          last_at: Date;
          users: number[];
          length: number;
          exhausted: boolean;
        }>(
          "SELECT last_at,users,length,exhausted FROM chains WHERE chat_id=$1 AND message_id=$2",
          [chatId, match.message_id],
        )
      ).rows[0];
      const chain = saved ?? {
        last_at: match.created_at,
        users: [match.user_id],
        length: 1,
        exhausted: false,
      };
      const timely = +now - +chain.last_at <= s.chainWindowSeconds * 1000;
      const repeatedUser = chain.users.includes(userId);
      const users = timely ? [...new Set([...chain.users, userId])] : [userId];
      const length = timely ? chain.length + 1 : 1;
      const exhausted =
        timely &&
        (chain.exhausted || repeatedUser || length > s.chainMaxLength);
      await tx.query(
        `INSERT INTO chains(chat_id,message_id,last_at,users,length,exhausted) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(chat_id,message_id) DO UPDATE SET last_at=$3,users=$4,length=$5,exhausted=$6`,
        [
          chatId,
          match.message_id,
          now,
          JSON.stringify(users),
          length,
          exhausted,
        ],
      );
      if (timely && users.length >= 2) {
        if (s.chainMode === "collapse")
          verdict = { action: "delete_nostrike", rule: "chain", silent: true };
        else if (!exhausted)
          verdict = { action: "none", rule: "chain", silent: true };
      }
    }
    verdict = {
      ...details,
      ...(verdict ??
        (await recordStrike(tx, chatId, userId, now, s, input.canMute))),
    };
    await stats(verdict.strike ? "repeat" : null);
    if (input.mediaGroupId)
      await tx.query(
        "INSERT INTO album_actions(chat_id,user_id,media_group_id,verdict,created_at) VALUES($1,$2,$3,$4,$5)",
        [chatId, userId, input.mediaGroupId, JSON.stringify(verdict), now],
      );
    return audit(verdict);
  });
}

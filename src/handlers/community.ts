import { InlineKeyboard, type Bot } from "grammy";
import type { Db } from "../db/index.js";
import type { AdminCache } from "../middleware/admin-cache.js";
import { loadChat } from "../db/chats.js";
import { forget } from "../db/privacy.js";
import { rate, top, weekStart } from "../stats/scores.js";
import { sendNotice } from "./enforcement.js";
import { respond } from "./respond.js";
import { decayedLevel } from "../enforce/strikes.js";
const ruleNames: Record<string, string> = {
  exact_text: "Repeated text",
  near_text: "Very similar text",
  link: "Repeated link",
  forward: "Repeated forward",
  media: "Repeated media",
  chain: "Part of a repeat chain",
  sticker_budget: "Too many stickers",
  sticker_run: "Too many stickers in a row",
  sticker_cooldown: "Same sticker too soon",
  min_length: "Message too short",
  emoji_only: "Emoji-only message",
  all_caps: "All-caps message",
  one_word: "One-word reply",
};
const actionNames: Record<string, string> = {
  none: "no penalty",
  warn: "warning",
  delete: "message removed",
  delete_nostrike: "message removed, no strike",
  mute: "message removed and muted",
};
export function registerCommunity(
  bot: Bot,
  db: Db,
  admins: AdminCache,
  clock: () => Date,
): void {
  bot.command("me", async (ctx) => {
    if (ctx.chat.type === "private" || !ctx.from) return;
    const chat = await loadChat(db, ctx.chat.id);
    if (!chat) return;
    const s = (
      await db.query<{
        originals: number;
        repeats: number;
        streak: number;
        best_streak: number;
      }>(
        "SELECT originals,repeats,streak,best_streak FROM stats WHERE chat_id=$1 AND user_id=$2",
        [ctx.chat.id, ctx.from.id],
      )
    ).rows[0] ?? { originals: 0, repeats: 0, streak: 0, best_streak: 0 };
    const strike = (
      await db.query<{ level: number; updated_at: Date }>(
        "SELECT level,updated_at FROM strikes WHERE chat_id=$1 AND user_id=$2",
        [ctx.chat.id, ctx.from.id],
      )
    ).rows[0];
    const level = strike
      ? decayedLevel(strike.level, strike.updated_at, clock(), chat.settings)
      : 0;
    await respond(
      ctx,
      `Originals: ${s.originals}; repeats: ${s.repeats}; originality: ${rate(s.originals, s.repeats)}; streak: ${s.streak}; best streak: ${s.best_streak}; strike level: ${level.toFixed(2)}.`,
    );
  });
  bot.command("top", async (ctx) => {
    if (ctx.chat.type === "private") return;
    const now = clock();
    const claim = await db.query(
      "UPDATE chats SET last_top_at=$2 WHERE chat_id=$1 AND removed_at IS NULL AND (last_top_at IS NULL OR last_top_at<=$3) RETURNING chat_id",
      [ctx.chat.id, now, new Date(+now - 60000)],
    );
    if (claim.rows.length)
      await ctx.reply(await top(db, ctx.chat.id, weekStart(now)), {
        reply_parameters: { message_id: ctx.msg.message_id },
      });
  });
  bot.command("why", async (ctx) => {
    if (ctx.chat.type === "private" || !ctx.from) return;
    const target = ctx.msg.reply_to_message?.from;
    const admin = target && (await admins.isAdmin(ctx, ctx.from.id));
    const rows = await db.query<{
      rule: string;
      action: string;
      detail: { strike?: number; matchedAt?: string };
      raw_text: string | null;
      created_at: Date | null;
    }>(
      `SELECT a.rule,a.action,a.detail,m.raw_text,m.created_at FROM actions a LEFT JOIN messages m ON m.chat_id=a.chat_id AND m.message_id=a.matched_message_id WHERE a.chat_id=$1 AND a.user_id=$2 ORDER BY a.id DESC LIMIT $3`,
      [ctx.chat.id, admin ? target.id : ctx.from.id, admin ? 5 : 1],
    );
    await sendNotice(
      ctx,
      ctx.from.id,
      rows.rows
        .map(
          (r) =>
            `${ruleNames[r.rule] ?? r.rule}: ${actionNames[r.action] ?? r.action}${r.detail.strike ? ` (strike ${r.detail.strike})` : ""}.` +
            (r.created_at || r.detail.matchedAt
              ? ` Matched a message from ${(r.created_at?.toISOString() ?? r.detail.matchedAt ?? "").slice(0, 16).replace("T", " ")} UTC: ${r.raw_text === null ? "text no longer stored" : JSON.stringify([...r.raw_text].slice(0, 200).join(""))}.`
              : ""),
        )
        .join("\n\n") || "No actions recorded.",
    );
  });
  const summary = (counts: Record<string, number>) =>
    `Removed: ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}. Fingerprints and strike state remain.`;
  bot.command("forgetme", async (ctx) => {
    if (!ctx.from) return;
    if (ctx.chat.type === "private") {
      await ctx.reply(
        "Remove your stored text, display names, scores and helper state across every chat?",
        {
          reply_markup: new InlineKeyboard().text(
            "Confirm removal",
            `forget:${ctx.from.id}`,
          ),
        },
      );
      return;
    }
    if (!(await loadChat(db, ctx.chat.id))) return;
    await respond(
      ctx,
      summary(await forget(db, ctx.chat.id, ctx.from.id, clock())),
    );
  });
  bot.callbackQuery(/^forget:(\d+)$/, async (ctx) => {
    if (ctx.chat?.type !== "private" || Number(ctx.match[1]) !== ctx.from.id)
      return;
    await ctx.answerCallbackQuery();
    const chats = await db.query<{ chat_id: number }>(
      "SELECT chat_id FROM chats",
    );
    const total: Record<string, number> = {};
    for (const { chat_id } of chats.rows) {
      const counts = await forget(db, chat_id, ctx.from.id, clock());
      for (const [k, v] of Object.entries(counts))
        total[k] = (total[k] ?? 0) + v;
    }
    await ctx.editMessageText(summary(total));
  });
}

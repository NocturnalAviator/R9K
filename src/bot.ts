import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { sequentialize } from "@grammyjs/runner";
import type { Logger } from "pino";
import type { Db } from "./db/index.js";
import type { Config } from "./config.js";
import { loadChat, saveChat, migrateChat } from "./db/chats.js";
import { AdminCache } from "./middleware/admin-cache.js";
import { memberRights, rightsSummary } from "./handlers/rights.js";
import { processMessage } from "./enforce/process-message.js";
import { applyVerdict } from "./handlers/enforcement.js";
import { registerSettings } from "./handlers/settings.js";
import { errorSummary } from "./errors.js";
export interface BotDeps {
  db: Db;
  config: Config;
  logger: Logger;
  clock: () => Date;
  botInfo?: UserFromGetMe;
}
export function createBot({
  db,
  config,
  logger,
  clock,
  botInfo,
}: BotDeps): Bot {
  const bot = new Bot(config.BOT_TOKEN, { botInfo });
  const admins = new AdminCache(clock);
  bot.use(
    sequentialize((ctx) => {
      const m = ctx.message;
      return [ctx.chat?.id, m?.migrate_to_chat_id, m?.migrate_from_chat_id]
        .filter((id): id is number => id !== undefined)
        .map(String);
    }),
  );
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      logger.error(
        {
          chatId: ctx.chat?.id,
          updateId: ctx.update.update_id,
          err: errorSummary(e),
        },
        "Update failed",
      );
    }
  });
  bot.catch((e) => {
    logger.error(
      { updateId: e.ctx.update.update_id, err: errorSummary(e.error) },
      "Update failed",
    );
  });
  bot.on("chat_member", (ctx) => {
    admins.invalidate(ctx.chat.id);
  });
  bot.on("my_chat_member", async (ctx) => {
    const member = ctx.myChatMember.new_chat_member;
    const removed = member.status === "left" || member.status === "kicked";
    const rights = memberRights(member);
    await saveChat(db, ctx.chat, rights, clock(), removed);
    admins.invalidate(ctx.chat.id);
    if (
      !removed &&
      (ctx.chat.type === "group" || ctx.chat.type === "supergroup")
    )
      try {
        await ctx.reply(rightsSummary(rights, ctx.chat.type));
      } catch (e) {
        logger.warn(
          { chatId: ctx.chat.id, err: errorSummary(e) },
          "Onboarding failed",
        );
      }
  });
  const intro =
    "R9K checks group messages for repeats and applies warnings, deletions and mutes. Add me to a group and grant admin, delete messages and restrict members rights. Commands: /start /settings /status /privacy /help.";
  const status = async (ctx: Context) => {
    if (!ctx.chat) return;
    if (ctx.chat.type === "private") {
      await ctx.reply(intro);
      return;
    }
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    const rights = memberRights(member);
    await saveChat(db, ctx.chat, rights, clock());
    const chat = await loadChat(db, ctx.chat.id);
    const s = chat!.settings;
    await ctx.reply(
      rightsSummary(rights, ctx.chat.type) +
        ` Settings: ${s.warnStrikes} warnings, ${s.deleteOnlyStrikes} delete-only strikes; mute ${s.muteBaseSeconds}s × ${s.muteMultiplier}, capped at ${s.muteCapSeconds}s; memory ${s.memorySeconds === null ? "forever" : s.memorySeconds + "s"}.`,
    );
  };
  // Commands and service messages also interrupt a user's sticker run.
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (
      msg?.from &&
      !msg.from.is_bot &&
      !msg.sticker &&
      (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup")
    ) {
      await db.query(
        "UPDATE sticker_state SET state=jsonb_set(state,'{run}','0') WHERE chat_id=$1 AND user_id=$2",
        [ctx.chat.id, msg.from.id],
      );
    }
    await next();
  });
  registerSettings(bot, db, admins, clock);
  bot.command("start", status);
  bot.command("status", status);
  bot.command("help", (ctx) => ctx.reply(intro));
  bot.command("privacy", (ctx) =>
    ctx.reply(
      "We store message text separately per chat, for at most its memory window and never more than 90 days, plus fingerprints, strike counts and action counts. Forever memory keeps fingerprints after text is erased. Ask the bot operator to remove your data; automated removal and the full policy come later.",
    ),
  );
  bot.on(["message", "edited_message"], async (ctx) => {
    const msg = ctx.message ?? ctx.editedMessage;
    if (!msg || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup"))
      return;
    if (msg.migrate_to_chat_id) {
      await migrateChat(db, ctx.chat.id, msg.migrate_to_chat_id);
      admins.invalidate(ctx.chat.id);
      admins.invalidate(msg.migrate_to_chat_id);
      return;
    }
    if (msg.migrate_from_chat_id) {
      await migrateChat(db, msg.migrate_from_chat_id, ctx.chat.id);
      admins.invalidate(msg.migrate_from_chat_id);
      admins.invalidate(ctx.chat.id);
      return;
    }
    const text = msg.text ?? msg.caption ?? "";
    const media =
      msg.photo?.reduce((largest, size) =>
        size.width * size.height > largest.width * largest.height
          ? size
          : largest,
      ) ??
      msg.video ??
      msg.animation ??
      msg.document ??
      msg.audio ??
      msg.voice ??
      msg.video_note;
    const kind = msg.photo
      ? "photo"
      : msg.video
        ? "video"
        : msg.animation
          ? "animation"
          : msg.document
            ? "document"
            : msg.audio
              ? "audio"
              : msg.voice
                ? "voice"
                : msg.video_note
                  ? "video_note"
                  : msg.sticker
                    ? "sticker"
                    : "text";
    const origin = msg.forward_origin;
    const entities = msg.entities ?? msg.caption_entities;
    if (
      (!text && !media && !msg.sticker && !origin) ||
      !msg.from ||
      msg.from.is_bot ||
      msg.sender_chat ||
      msg.is_automatic_forward ||
      text.startsWith("/") ||
      entities?.some((e) => e.type === "bot_command")
    )
      return;
    const chat = await loadChat(db, ctx.chat.id);
    if (!chat || chat.removed || !chat.rights.deleteMessages) return;
    const userIsAdmin = await admins.isAdmin(ctx, msg.from.id);
    const now = clock();
    const verdict = await processMessage(
      db,
      {
        chatId: ctx.chat.id,
        settings: chat.settings,
        messageId: msg.message_id,
        userId: msg.from.id,
        text,
        entities,
        isEdit: !!ctx.editedMessage,
        userIsAdmin,
        canMute:
          ctx.chat.type === "supergroup" &&
          chat.rights.restrictMembers &&
          !userIsAdmin,
        mediaGroupId: msg.media_group_id,
        kind,
        mediaId: media?.file_unique_id,
        stickerId: msg.sticker?.file_unique_id,
        isReply: !!msg.reply_to_message,
        forwardOrigin: origin
          ? {
              type: origin.type,
              chatId:
                origin.type === "channel"
                  ? origin.chat.id
                  : origin.type === "chat"
                    ? origin.sender_chat.id
                    : undefined,
              messageId: "message_id" in origin ? origin.message_id : undefined,
            }
          : undefined,
      },
      now,
    );
    logger.info(
      {
        chatId: ctx.chat.id,
        userId: msg.from.id,
        messageId: msg.message_id,
        action: verdict.action,
        rule: verdict.rule,
      },
      "Message processed",
    );
    await applyVerdict(
      ctx,
      msg.from.id,
      msg.message_id,
      verdict,
      chat.settings,
      now,
      logger,
    );
  });
  return bot;
}

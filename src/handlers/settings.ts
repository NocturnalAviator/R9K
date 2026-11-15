import { GrammyError, InlineKeyboard, type Bot, type Context } from "grammy";
import type { Logger } from "pino";
import type { Db } from "../db/index.js";
import { loadChat, saveChat, type ChatRow } from "../db/chats.js";
import type { AdminCache } from "../middleware/admin-cache.js";
import { errorSummary } from "../errors.js";
import { memberRights } from "./rights.js";
import { isEphemeral, sendEphemeral } from "./respond.js";
import {
  callback,
  controls,
  cycle,
  parseCallback,
  phraseId,
  renderMenu,
  type Screen,
} from "../settings/menu.js";
import { changeSettings, resetStrikes } from "../settings/store.js";
import { presets } from "../settings/presets.js";

const promptPrefix = "Reply with an allow-phrase (1–200 characters) for ";
class PhraseError extends Error {}
const isGroup = (ctx: Context): boolean =>
  ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

export function registerSettings(
  bot: Bot,
  db: Db,
  admins: AdminCache,
  clock: () => Date,
  logger: Logger,
): void {
  const drop = async (ctx: Context, id: number) => {
    await db.query(
      "DELETE FROM managed_chats WHERE chat_id=$1 AND user_id=$2",
      [id, ctx.from!.id],
    );
  };
  /** The ephemeral menu message a button press came from, if any. */
  const ephemeralId = (ctx: Context): number | undefined => {
    const message = ctx.callbackQuery?.message;
    return message && "ephemeral_message_id" in message
      ? message.ephemeral_message_id
      : undefined;
  };
  /**
   * Shows text where the admin is looking: edits the menu a button belongs to
   * (ephemeral in a group, ordinary in private), or sends a new message that
   * in a group only this admin can see.
   */
  const output = async (
    ctx: Context,
    text: string,
    reply_markup = new InlineKeyboard(),
  ) => {
    try {
      const ephemeral = ephemeralId(ctx);
      if (ephemeral !== undefined)
        await ctx.api.editEphemeralMessageText(
          ctx.chat!.id,
          ctx.from!.id,
          ephemeral,
          text,
          { reply_markup },
        );
      else if (ctx.callbackQuery?.message)
        await ctx.editMessageText(text, { reply_markup });
      else if (isGroup(ctx))
        await sendEphemeral(ctx, ctx.from!.id, text, reply_markup);
      else await ctx.reply(text, { reply_markup });
    } catch (e) {
      if (!(
        e instanceof GrammyError &&
        e.description.includes("message is not modified")
      ))
        throw e;
    }
  };
  /**
   * Checks, from the admin cache and the database only (no per-press network
   * calls), that the user administers the chat and the bot is still in it.
   */
  const authorize = async (
    ctx: Context,
    id: number,
  ): Promise<ChatRow | undefined> => {
    if (!ctx.from) return;
    let admin = false;
    try {
      admin = await admins.isAdmin(ctx, ctx.from.id, id);
    } catch {
      /* Fail closed. */
    }
    if (!admin) {
      await drop(ctx, id);
      await output(ctx, "You are no longer an admin of that chat");
      return;
    }
    const chat = await loadChat(db, id);
    if (!chat || chat.removed) {
      await drop(ctx, id);
      await output(ctx, "The bot is no longer in that chat");
      return;
    }
    return chat;
  };
  const remember = async (ctx: Context, id: number) => {
    await db.query(
      "INSERT INTO managed_chats(user_id,chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [ctx.from!.id, id],
    );
  };
  const render = async (
    ctx: Context,
    id: number,
    screen: Screen = "main",
    arg = "",
    confirm = false,
  ) => {
    const chat = await authorize(ctx, id);
    if (!chat) return;
    const menu = renderMenu(
      id,
      chat.title,
      chat.settings,
      screen,
      arg,
      confirm,
    );
    await output(ctx, menu.text, menu.reply_markup);
  };
  /** Removes a visibly sent admin command so the group never sees it linger. */
  const tidy = async (ctx: Context) => {
    if (isEphemeral(ctx) || !ctx.msg) return;
    await ctx.deleteMessage().catch(() => undefined);
  };
  /** Group admin gate for commands; registers a chat the bot has not seen. */
  const groupAdmin = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from || !ctx.chat) return false;
    if (!(await admins.isAdmin(ctx, ctx.from.id))) {
      if (isEphemeral(ctx))
        await sendEphemeral(
          ctx,
          ctx.from.id,
          "Only admins of this chat can change its settings.",
        );
      return false;
    }
    if (!(await loadChat(db, ctx.chat.id))) {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
      await saveChat(db, ctx.chat, memberRights(member), clock());
    }
    return true;
  };
  const addPhrase = async (
    ctx: Context,
    id: number,
    messageId: number,
    raw: string,
  ): Promise<string | undefined> => {
    const phrase = raw.trim();
    if (!phrase || [...phrase].length > 200)
      return "Use a phrase of 1–200 characters.";
    try {
      await changeSettings(
        db,
        id,
        ctx.from!.id,
        messageId,
        clock(),
        "allowPhrases",
        (s) => {
          if (s.allowPhrases.includes(phrase)) return s;
          if (s.allowPhrases.length >= 50) throw new PhraseError();
          return { ...s, allowPhrases: [...s.allowPhrases, phrase] };
        },
      );
    } catch (e) {
      if (!(e instanceof PhraseError)) throw e;
      return "The chat already has 50 allow-phrases. Remove one first.";
    }
    return undefined;
  };

  bot.command("settings", async (ctx) => {
    if (isGroup(ctx)) {
      if (!(await groupAdmin(ctx))) return;
      await tidy(ctx);
      await remember(ctx, ctx.chat.id);
      try {
        // In the group itself, visible to this admin only.
        await render(ctx, ctx.chat.id);
      } catch (e) {
        logger.warn(
          { chatId: ctx.chat.id, err: errorSummary(e) },
          "Ephemeral settings menu failed; offering private chat",
        );
        await ctx.reply("Manage this chat’s settings in private.", {
          reply_markup: new InlineKeyboard().url(
            "Open settings in private",
            `https://t.me/${ctx.me.username}?start=s_${ctx.chat.id}`,
          ),
        });
      }
      return;
    }
    if (ctx.chat.type !== "private" || !ctx.from) return;
    // User-scoped directory enumeration is required for the private chat picker.
    const rows = (
      await db.query<{ chat_id: number }>(
        "SELECT chat_id FROM managed_chats WHERE user_id=$1 ORDER BY chat_id",
        [ctx.from.id],
      )
    ).rows;
    const valid: { id: number; title: string }[] = [];
    for (const row of rows) {
      const chat = await authorize(ctx, row.chat_id);
      if (chat) valid.push({ id: row.chat_id, title: chat.title });
    }
    if (valid.length === 1) await render(ctx, valid[0]!.id);
    else if (!valid.length)
      await ctx.reply(
        "Run /settings in a group you administer. The menu opens right there, visible only to you; afterwards the group is also listed here.",
      );
    else {
      const kb = new InlineKeyboard();
      for (const chat of valid)
        kb.text(chat.title, callback(chat.id, "main")).row();
      await ctx.reply("Choose a chat:", { reply_markup: kb });
    }
  });
  bot.command("allow", async (ctx) => {
    if (!isGroup(ctx) || !ctx.from) return;
    if (!(await groupAdmin(ctx))) return;
    await tidy(ctx);
    const problem =
      typeof ctx.match === "string" && ctx.match.trim()
        ? await addPhrase(ctx, ctx.chat.id, ctx.msg.message_id, ctx.match)
        : "Usage: /allow followed by the phrase people may repeat, for example: /allow good morning";
    if (problem) await sendEphemeral(ctx, ctx.from.id, problem);
    else await render(ctx, ctx.chat.id, "exempt");
  });
  bot.command("start", async (ctx, next) => {
    if (
      ctx.chat.type !== "private" ||
      typeof ctx.match !== "string" ||
      !/^s_-\d{1,14}$/.test(ctx.match)
    )
      return next();
    const id = Number(ctx.match.slice(2));
    if (!(await authorize(ctx, id))) return;
    await remember(ctx, id);
    await render(ctx, id);
  });
  bot.callbackQuery(/^s:/, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const ephemeral = ephemeralId(ctx);
    // A menu lives either in private chat or in an ephemeral group message
    // for the chat it configures; anything else is not ours to act on.
    if (
      ctx.chat?.type !== "private" &&
      (ephemeral === undefined || parsed?.chatId !== ctx.chat?.id)
    ) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (parsed?.op === "add" && ephemeral !== undefined) {
      await ctx.answerCallbackQuery({
        text: "Send /allow followed by the phrase in this chat, e.g. /allow good morning. Only you will see the command.",
        show_alert: true,
      });
      return;
    }
    // Answer first so the button's spinner stops while the work happens.
    const answered = ctx.answerCallbackQuery().catch(() => undefined);
    try {
      if (!parsed) {
        await output(ctx, "Invalid settings button. Use /settings to reopen.");
        return;
      }
      const { chatId: id, screen, op, arg } = parsed;
      if (op === "close") {
        if (ephemeral !== undefined)
          await ctx.api.deleteEphemeralMessage(
            ctx.chat!.id,
            ctx.from.id,
            ephemeral,
          );
        else await ctx.deleteMessage();
        return;
      }
      if (!(await authorize(ctx, id))) return;
      const messageId = ctx.callbackQuery.message?.message_id ?? 0;
      const write = (
        key: string,
        change: Parameters<typeof changeSettings>[6],
      ) => changeSettings(db, id, ctx.from.id, messageId, clock(), key, change);
      if (op === "cycle") {
        const index = /^\d+$/.test(arg) ? Number(arg) : -1;
        const control = controls[index];
        if (!control || control.screen !== screen) return;
        await write(control.key, (s) => cycle(s, index));
      } else if (op === "apply" && screen === "preset") {
        if (!Object.hasOwn(presets, arg)) return;
        await write("preset", (s) => ({
          ...presets[arg as keyof typeof presets],
          allowPhrases: s.allowPhrases,
        }));
      } else if (op === "clear" && screen === "reset") {
        await resetStrikes(db, id, ctx.from.id, messageId, clock());
      } else if (op === "remove" && screen === "exempt") {
        await write("allowPhrases", (s) => ({
          ...s,
          allowPhrases: s.allowPhrases.filter((p) => phraseId(p) !== arg),
        }));
      } else if (op === "add" && screen === "exempt") {
        const chat = await loadChat(db, id);
        await ctx.reply(
          `${promptPrefix}${chat?.title ?? "the chat"}.\n#${id}`,
          {
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Allow-phrase",
            },
          },
        );
        return;
      } else if (op !== "show" && op !== "confirm") return;
      if (
        op === "confirm" &&
        !(
          screen === "reset" ||
          (screen === "preset" && Object.hasOwn(presets, arg))
        )
      )
        return;
      await render(
        ctx,
        id,
        screen,
        op === "show" || op === "confirm" ? arg : "",
        op === "confirm",
      );
    } finally {
      await answered;
    }
  });
  bot.on("message:text", async (ctx, next) => {
    const reply = ctx.message.reply_to_message;
    if (
      ctx.chat.type !== "private" ||
      reply?.from?.id !== ctx.me.id ||
      !reply.text?.startsWith(promptPrefix)
    )
      return next();
    const match = /\n#(-\d{1,14})$/.exec(reply.text);
    if (!match) return next();
    const id = Number(match[1]);
    if (!(await authorize(ctx, id))) return;
    const problem = await addPhrase(
      ctx,
      id,
      ctx.message.message_id,
      ctx.message.text,
    );
    if (problem) {
      await ctx.reply(`${problem} Reply to the same prompt to try again.`);
      return;
    }
    await render(ctx, id, "exempt");
  });
}

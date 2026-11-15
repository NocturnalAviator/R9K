import { GrammyError, InlineKeyboard, type Bot, type Context } from "grammy";
import type { Db } from "../db/index.js";
import { loadChat, saveChat } from "../db/chats.js";
import type { AdminCache } from "../middleware/admin-cache.js";
import { memberRights } from "./rights.js";
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
export function registerSettings(
  bot: Bot,
  db: Db,
  admins: AdminCache,
  clock: () => Date,
): void {
  const drop = async (ctx: Context, id: number) => {
    await db.query(
      "DELETE FROM managed_chats WHERE chat_id=$1 AND user_id=$2",
      [id, ctx.from!.id],
    );
  };
  const output = async (
    ctx: Context,
    text: string,
    reply_markup = new InlineKeyboard(),
  ) => {
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, { reply_markup });
      } catch (e) {
        if (!(
          e instanceof GrammyError &&
          e.description.includes("message is not modified")
        ))
          throw e;
      }
    } else await ctx.reply(text, { reply_markup });
  };
  const authorize = async (
    ctx: Context,
    id: number,
  ): Promise<string | undefined> => {
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
    try {
      const member = await ctx.api.getChatMember(id, ctx.me.id);
      if (
        member.status === "left" ||
        member.status === "kicked" ||
        (member.status === "restricted" && !member.is_member)
      ) {
        await drop(ctx, id);
        await output(ctx, "The bot is no longer in that chat");
        return;
      }
      const chat = await ctx.api.getChat(id);
      if (chat.type !== "group" && chat.type !== "supergroup") return;
      await saveChat(db, chat, memberRights(member), clock());
      return chat.title;
    } catch {
      await drop(ctx, id);
      await output(ctx, "The bot cannot access that chat");
      return;
    }
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
    const title = await authorize(ctx, id);
    if (title === undefined) return;
    const chat = await loadChat(db, id);
    if (!chat) return;
    const menu = renderMenu(id, title, chat.settings, screen, arg, confirm);
    await output(ctx, menu.text, menu.reply_markup);
  };
  bot.command("settings", async (ctx) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      if (!ctx.from || !(await admins.isAdmin(ctx, ctx.from.id))) return;
      if ((await authorize(ctx, ctx.chat.id)) === undefined) return;
      await remember(ctx, ctx.chat.id);
      await ctx.reply("Manage this chat’s settings in private.", {
        reply_markup: new InlineKeyboard().url(
          "Open settings in private",
          `https://t.me/${ctx.me.username}?start=s_${ctx.chat.id}`,
        ),
      });
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
      const title = await authorize(ctx, row.chat_id);
      if (title !== undefined) valid.push({ id: row.chat_id, title });
    }
    if (valid.length === 1) await render(ctx, valid[0]!.id);
    else if (!valid.length)
      await ctx.reply(
        "Run /settings in a group you administer to open its settings here.",
      );
    else {
      const kb = new InlineKeyboard();
      for (const chat of valid)
        kb.text(chat.title, callback(chat.id, "main")).row();
      await ctx.reply("Choose a chat:", { reply_markup: kb });
    }
  });
  bot.command("start", async (ctx, next) => {
    if (
      ctx.chat.type !== "private" ||
      typeof ctx.match !== "string" ||
      !/^s_-\d{1,14}$/.test(ctx.match)
    )
      return next();
    const id = Number(ctx.match.slice(2));
    if ((await authorize(ctx, id)) === undefined) return;
    await remember(ctx, id);
    await render(ctx, id);
  });
  bot.callbackQuery(/^s:/, async (ctx) => {
    // Answer first so the button's spinner stops while the work happens.
    const answered = ctx.answerCallbackQuery().catch(() => undefined);
    try {
      if (ctx.chat?.type !== "private") return;
      const parsed = parseCallback(ctx.callbackQuery.data);
      if (!parsed) {
        await output(ctx, "Invalid settings button. Use /settings to reopen.");
        return;
      }
      const { chatId: id, screen, op, arg } = parsed;
      if ((await authorize(ctx, id)) === undefined) return;
      const write = (
        key: string,
        change: Parameters<typeof changeSettings>[6],
      ) =>
        changeSettings(
          db,
          id,
          ctx.from.id,
          ctx.callbackQuery.message?.message_id ?? 0,
          clock(),
          key,
          change,
        );
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
        await resetStrikes(
          db,
          id,
          ctx.from.id,
          ctx.callbackQuery.message?.message_id ?? 0,
          clock(),
        );
      } else if (op === "remove" && screen === "exempt") {
        await write("allowPhrases", (s) => ({
          ...s,
          allowPhrases: s.allowPhrases.filter((p) => phraseId(p) !== arg),
        }));
      } else if (op === "add" && screen === "exempt") {
        const title = await authorize(ctx, id);
        if (title === undefined) return;
        await ctx.reply(`${promptPrefix}${title}.\n#${id}`, {
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Allow-phrase",
          },
        });
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
    if ((await authorize(ctx, id)) === undefined) return;
    const phrase = ctx.message.text.trim();
    if (!phrase || [...phrase].length > 200) {
      await ctx.reply(
        "Use a phrase of 1–200 characters. Reply to the same prompt to try again.",
      );
      return;
    }
    try {
      await changeSettings(
        db,
        id,
        ctx.from.id,
        ctx.message.message_id,
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
      await ctx.reply(
        "The chat already has 50 allow-phrases. Remove one first.",
      );
      return;
    }
    await render(ctx, id, "exempt");
  });
}

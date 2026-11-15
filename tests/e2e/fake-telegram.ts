// A small in-process stand-in for the Telegram Bot API, for end-to-end tests.
// The real bot process (src/main.ts) polls it over HTTP exactly as it polls
// Telegram; tests script users through the methods below and inspect what
// each user would see. It models only what this bot uses.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const BOT_TOKEN = "424242:e2e-test-token";
export const BOT = {
  id: 424242,
  is_bot: true,
  first_name: "R9K",
  username: "r9k_e2e_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

type Json = Record<string, unknown>;
export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
}
interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}
export interface Sent {
  /** 0 for ephemeral messages, as in the Bot API. */
  message_id: number;
  ephemeral_message_id?: number;
  /** Set for ephemeral messages: the only user who can see it. */
  receiver?: number;
  chat: number;
  from: number;
  text: string;
  buttons: Button[];
  deleted: boolean;
  reactions: string[];
}
export interface Call {
  method: string;
  payload: Json;
  at: number;
  ok: boolean;
}
type MemberStatus = "creator" | "administrator" | "member";
interface Chat {
  id: number;
  type: "supergroup" | "group" | "private";
  title?: string;
  members: Map<number, { user: User; status: MemberStatus }>;
  botRights: { can_delete_messages: boolean; can_restrict_members: boolean };
  nextMessageId: number;
}
const fail = (error_code: number, description: string, extra: Json = {}) => ({
  ok: false,
  error_code,
  description,
  ...extra,
});

export class FakeTelegram {
  readonly calls: Call[] = [];
  readonly messages: Sent[] = [];
  /** restrictChatMember calls that succeeded. */
  readonly restrictions: { chat: number; user: number; until: number }[] = [];
  private readonly chats = new Map<number, Chat>();
  private readonly updates: Json[] = [];
  private nextUpdateId = 1;
  private nextEphemeralId = 1000;
  private nextUserId = 100;
  private waiters: (() => void)[] = [];
  /** One-shot failures: the next call of a method gets this response. */
  private readonly injected = new Map<string, Json[]>();
  private server!: Server;
  url = "";

  static async start(): Promise<FakeTelegram> {
    const tg = new FakeTelegram();
    tg.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const method = /^\/bot[^/]+\/(\w+)$/.exec(req.url ?? "")?.[1];
          let payload: Json = {};
          try {
            const body = Buffer.concat(chunks).toString();
            if (body) payload = JSON.parse(body) as Json;
          } catch {
            /* Methods without parameters send no body. */
          }
          const result = method
            ? await tg.handle(method, payload)
            : fail(404, "Not Found");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })();
      });
    });
    await new Promise<void>((r) => tg.server.listen(0, "127.0.0.1", r));
    tg.url = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`;
    return tg;
  }
  async stop(): Promise<void> {
    this.wake();
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---- Scripting the world -------------------------------------------------

  user(first_name: string): User {
    return { id: this.nextUserId++, is_bot: false, first_name };
  }
  /** Creates a supergroup with the bot as an admin holding the given rights. */
  supergroup(
    id: number,
    title: string,
    creator: User,
    botRights = { can_delete_messages: true, can_restrict_members: true },
  ): number {
    const chat: Chat = {
      id,
      type: "supergroup",
      title,
      members: new Map([[creator.id, { user: creator, status: "creator" }]]),
      botRights,
      nextMessageId: 1,
    };
    this.chats.set(id, chat);
    this.push({
      my_chat_member: {
        chat: this.chatJson(chat),
        from: creator,
        date: this.now(),
        old_chat_member: { status: "left", user: BOT },
        new_chat_member: this.botMember(chat),
      },
    });
    return id;
  }
  promote(chatId: number, user: User): void {
    this.chat(chatId).members.set(user.id, { user, status: "administrator" });
  }
  /** A user posts a message (or, with `ephemeral`, an ephemeral command). */
  say(
    chatId: number,
    from: User,
    text: string,
    extra: Json & { ephemeral?: boolean } = {},
  ): Sent {
    const chat = this.chat(chatId);
    if (!chat.members.has(from.id))
      chat.members.set(from.id, { user: from, status: "member" });
    const { ephemeral, ...rest } = extra;
    const sent = this.record(
      chat,
      from.id,
      text,
      [],
      ephemeral ? from.id : undefined,
    );
    this.push({ message: this.messageJson(sent, from, rest) });
    return sent;
  }
  sticker(chatId: number, from: User, fileUniqueId: string): Sent {
    return this.say(chatId, from, "", {
      sticker: {
        file_id: `f-${fileUniqueId}`,
        file_unique_id: fileUniqueId,
        type: "regular",
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
      },
    });
  }
  edit(message: Sent, from: User, text: string): void {
    message.text = text;
    this.push({
      edited_message: {
        ...this.messageJson(message, from, {}),
        edit_date: this.now(),
      },
    });
  }
  /** A user presses the inline button with this label on a bot message. */
  press(message: Sent, from: User, label: string): void {
    const button = message.buttons.find((b) => b.text.startsWith(label));
    if (!button?.callback_data)
      throw new Error(
        `No button "${label}" on message; buttons: ${message.buttons.map((b) => b.text).join(" | ")}`,
      );
    this.push({
      callback_query: {
        id: String(this.nextUpdateId),
        from,
        chat_instance: "e2e",
        data: button.callback_data,
        message: this.messageJson(message, BOT, {}),
      },
    });
  }
  /** Makes the next call of `method` fail once with this response. */
  failNext(method: string, response: Json): void {
    this.injected.set(method, [...(this.injected.get(method) ?? []), response]);
  }

  // ---- What each party can see --------------------------------------------

  /** Messages every member of the chat can see (not deleted, not ephemeral). */
  visible(chatId: number): Sent[] {
    return this.messages.filter(
      (m) => m.chat === chatId && !m.deleted && m.receiver === undefined,
    );
  }
  /** Ephemeral messages from the bot that only this user can see. */
  ephemeral(chatId: number, user: User): Sent[] {
    return this.messages.filter(
      (m) =>
        m.chat === chatId &&
        !m.deleted &&
        m.receiver === user.id &&
        m.from === BOT.id,
    );
  }
  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
  /** Polls until `check` returns something truthy; fails with recent calls. */
  async until<T>(
    check: () => T,
    what: string,
    timeout = 8000,
  ): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${what}. Recent bot calls:\n` +
            this.calls
              .filter((c) => c.method !== "getUpdates")
              .slice(-12)
              .map(
                (c) =>
                  `  ${c.method} ${JSON.stringify(c.payload).slice(0, 160)}`,
              )
              .join("\n"),
        );
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  /**
   * Waits until the bot has finished everything queued so far for this chat.
   * The bot handles one chat's updates in order, so an answered probe command
   * from a throwaway user means all earlier updates are done.
   */
  async settled(chatId: number): Promise<void> {
    const probe = this.user("probe");
    this.say(chatId, probe, "/help", { ephemeral: true });
    await this.until(
      () => this.ephemeral(chatId, probe).length > 0,
      "the bot to settle",
    );
  }

  // ---- Bot API -------------------------------------------------------------

  private async handle(method: string, p: Json): Promise<Json> {
    const call: Call = { method, payload: p, at: Date.now(), ok: true };
    if (method !== "getUpdates") this.calls.push(call);
    const injected = this.injected.get(method)?.shift();
    const response = injected ?? (await this.respond(method, p));
    call.ok = response.ok === true;
    return response;
  }
  private async respond(method: string, p: Json): Promise<Json> {
    const ok = (result: unknown): Json => ({ ok: true, result });
    switch (method) {
      case "getMe":
        return ok(BOT);
      case "getUpdates": {
        const offset = Number(p.offset ?? 0);
        const pending = () =>
          this.updates.filter((u) => (u.update_id as number) >= offset);
        if (!pending().length)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            this.waiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        return ok(pending());
      }
      case "sendMessage": {
        const chat = this.chats.get(Number(p.chat_id));
        if (!chat) return fail(400, "Bad Request: chat not found");
        const receiver = (p.ephemeral_message_parameters as Json | undefined)
          ?.receiver_user_id as number | undefined;
        if (receiver !== undefined && !chat.members.has(receiver))
          return fail(400, "Bad Request: receiver is not a member of the chat");
        const sent = this.record(
          chat,
          BOT.id,
          String(p.text),
          this.buttons(p.reply_markup),
          receiver,
        );
        return ok(this.messageJson(sent, BOT, {}));
      }
      case "editMessageText":
      case "editEphemeralMessageText": {
        const message = this.messages.find(
          (m) =>
            m.chat === Number(p.chat_id) &&
            !m.deleted &&
            (method === "editMessageText"
              ? m.receiver === undefined && m.message_id === p.message_id
              : m.receiver === p.receiver_user_id &&
                m.ephemeral_message_id === p.ephemeral_message_id),
        );
        if (!message)
          return fail(400, "Bad Request: message to edit not found");
        const buttons = this.buttons(p.reply_markup);
        if (
          message.text === p.text &&
          JSON.stringify(message.buttons) === JSON.stringify(buttons)
        )
          return fail(400, "Bad Request: message is not modified");
        message.text = String(p.text);
        message.buttons = buttons;
        return ok(true);
      }
      case "deleteMessage":
      case "deleteEphemeralMessage": {
        const chat = this.chats.get(Number(p.chat_id));
        const message = this.messages.find(
          (m) =>
            m.chat === Number(p.chat_id) &&
            !m.deleted &&
            (method === "deleteMessage"
              ? m.receiver === undefined && m.message_id === p.message_id
              : m.receiver === p.receiver_user_id &&
                m.ephemeral_message_id === p.ephemeral_message_id),
        );
        if (!message)
          return fail(400, "Bad Request: message to delete not found");
        if (
          method === "deleteMessage" &&
          message.from !== BOT.id &&
          !chat?.botRights.can_delete_messages
        )
          return fail(400, "Bad Request: message can't be deleted");
        message.deleted = true;
        return ok(true);
      }
      case "setMessageReaction": {
        const message = this.messages.find(
          (m) => m.chat === Number(p.chat_id) && m.message_id === p.message_id,
        );
        if (!message || message.deleted)
          return fail(400, "Bad Request: message to react not found");
        message.reactions = ((p.reaction as Json[] | undefined) ?? []).map(
          (r) => String(r.emoji),
        );
        return ok(true);
      }
      case "restrictChatMember": {
        const chat = this.chats.get(Number(p.chat_id));
        const target = chat?.members.get(Number(p.user_id));
        if (!chat || !target) return fail(400, "Bad Request: user not found");
        if (!chat.botRights.can_restrict_members)
          return fail(400, "Bad Request: not enough rights to restrict");
        if (target.status !== "member")
          return fail(400, "Bad Request: user is an administrator of the chat");
        this.restrictions.push({
          chat: chat.id,
          user: target.user.id,
          until: Number(p.until_date),
        });
        return ok(true);
      }
      case "getChatAdministrators": {
        const chat = this.chats.get(Number(p.chat_id));
        if (!chat) return fail(400, "Bad Request: chat not found");
        return ok([
          this.botMember(chat),
          ...[...chat.members.values()]
            .filter((m) => m.status !== "member")
            .map((m) => this.memberJson(m)),
        ]);
      }
      case "getChatMember": {
        const chat = this.chats.get(Number(p.chat_id));
        if (!chat) return fail(400, "Bad Request: chat not found");
        if (Number(p.user_id) === BOT.id) return ok(this.botMember(chat));
        const member = chat.members.get(Number(p.user_id));
        return member
          ? ok(this.memberJson(member))
          : fail(400, "Bad Request: user not found");
      }
      case "getChat": {
        const chat = this.chats.get(Number(p.chat_id));
        return chat
          ? ok(this.chatJson(chat))
          : fail(400, "Bad Request: chat not found");
      }
      default:
        // setMyCommands, answerCallbackQuery, deleteWebhook, ...
        return ok(true);
    }
  }

  // ---- Internals -----------------------------------------------------------

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }
  private chat(id: number): Chat {
    const chat = this.chats.get(id);
    if (!chat) throw new Error(`Unknown chat ${id}`);
    return chat;
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  private push(update: Json): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
    this.wake();
  }
  private record(
    chat: Chat,
    from: number,
    text: string,
    buttons: Button[],
    receiver?: number,
  ): Sent {
    const sent: Sent = {
      message_id: receiver === undefined ? chat.nextMessageId++ : 0,
      ephemeral_message_id:
        receiver === undefined ? undefined : this.nextEphemeralId++,
      receiver,
      chat: chat.id,
      from,
      text,
      buttons,
      deleted: false,
      reactions: [],
    };
    this.messages.push(sent);
    return sent;
  }
  private buttons(markup: unknown): Button[] {
    const rows = (markup as { inline_keyboard?: Button[][] } | undefined)
      ?.inline_keyboard;
    return rows ? rows.flat() : [];
  }
  private chatJson(chat: Chat): Json {
    return { id: chat.id, type: chat.type, title: chat.title };
  }
  private memberJson(m: { user: User; status: MemberStatus }): Json {
    return m.status === "administrator"
      ? {
          status: "administrator",
          user: m.user,
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: true,
          can_restrict_members: true,
        }
      : { status: m.status, user: m.user, is_anonymous: false };
  }
  private botMember(chat: Chat): Json {
    return {
      status: "administrator",
      user: BOT,
      can_be_edited: false,
      is_anonymous: false,
      can_manage_chat: true,
      ...chat.botRights,
    };
  }
  private messageJson(sent: Sent, from: User | typeof BOT, extra: Json): Json {
    const command = /^\/\S+/.exec(sent.text)?.[0];
    const receiver =
      sent.receiver === undefined
        ? undefined
        : this.chat(sent.chat).members.get(sent.receiver)?.user;
    return {
      message_id: sent.message_id,
      ...(sent.ephemeral_message_id === undefined
        ? {}
        : {
            ephemeral_message_id: sent.ephemeral_message_id,
            receiver_user: receiver,
          }),
      date: this.now(),
      chat: this.chatJson(this.chat(sent.chat)),
      from,
      ...(sent.text ? { text: sent.text } : {}),
      ...(command
        ? {
            entities: [
              { type: "bot_command", offset: 0, length: command.length },
            ],
          }
        : {}),
      ...(sent.buttons.length
        ? { reply_markup: { inline_keyboard: sent.buttons.map((b) => [b]) } }
        : {}),
      ...extra,
    };
  }
}

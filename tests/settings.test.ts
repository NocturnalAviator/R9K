import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { pino } from "pino";
import type {
  Update,
  UserFromGetMe,
  ChatMember,
  InlineKeyboardMarkup,
} from "grammy/types";
import { createBot } from "../src/bot.js";
import { pgliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { loadChat, saveChat } from "../src/db/chats.js";
import { classic, relaxed } from "../src/settings/presets.js";
import {
  callback,
  controls,
  screens,
  renderMenu,
  phraseId,
} from "../src/settings/menu.js";
import { changeSettings } from "../src/settings/store.js";
const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "R9K",
  username: "r9k_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const user = { id: 10, is_bot: false, first_name: "Tester" };
const admin: ChatMember = {
  status: "creator",
  user: { ...user, id: 20 },
  is_anonymous: false,
};
const botAdmin: ChatMember = {
  status: "administrator",
  user: botInfo,
  is_anonymous: false,
  can_be_edited: false,
  can_manage_chat: true,
  can_delete_messages: true,
  can_manage_video_chats: false,
  can_restrict_members: true,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_send_welcome_messages: false,
};

const db = pgliteDb();
const now = new Date("2026-01-01T00:00:00Z");
const group = { id: -1, type: "supergroup" as const, title: "Test chat" };
const privateChat = { id: 20, type: "private" as const, first_name: "Admin" };
const config = {
  BOT_TOKEN: "999:fake",
  PGLITE_DIR: "unused",
  LOG_LEVEL: "silent" as const,
};
const calls: { method: string; payload: Record<string, unknown> }[] = [];
let bot: ReturnType<typeof createBot>;
let updateId = 0;
let currentAdmins = [admin];
let secondChatAdmin = false;
let botMember: ChatMember = botAdmin;
let failEdit = false;
const logger = pino({ level: "silent" });
const errors = vi.spyOn(logger, "error");
function makeBot() {
  bot = createBot({ db, config, logger, clock: () => now, botInfo });
  bot.api.config.use(async (_prev, method, payload) => {
    const data = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: data });
    if (method === "getChatAdministrators")
      return {
        ok: true,
        result: data.chat_id === -2 && !secondChatAdmin ? [] : currentAdmins,
      } as never;
    if (method === "getChatMember")
      return { ok: true, result: botMember } as never;
    if (method === "getChat")
      return { ok: true, result: { ...group, id: data.chat_id } } as never;
    if (method === "editMessageText" && failEdit)
      return {
        ok: false,
        error_code: 400,
        description: "Bad Request: message is not modified",
      };
    return {
      ok: true,
      result:
        method === "sendMessage"
          ? {
              message_id: 100,
              date: 0,
              chat: privateChat,
              from: botInfo,
              text: data.text,
            }
          : true,
    } as never;
  });
}
beforeAll(() => migrate(db));
afterAll(() => db.close());
beforeEach(async () => {
  for (const id of [-1, -2, -12345678901234])
    await db.query("DELETE FROM chats WHERE chat_id=$1", [id]);
  await saveChat(
    db,
    group,
    { admin: true, deleteMessages: true, restrictMembers: true },
    now,
  );
  currentAdmins = [admin];
  secondChatAdmin = false;
  botMember = botAdmin;
  failEdit = false;
  updateId = 0;
  calls.length = 0;
  errors.mockClear();
  makeBot();
});
async function message(
  text: string,
  chat = privateChat as typeof privateChat | typeof group,
  from = admin.user,
  extra: Record<string, unknown> = {},
) {
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: +now / 1000,
      chat,
      from,
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              {
                type: "bot_command",
                offset: 0,
                length: text.split(" ")[0]!.length,
              },
            ],
          }
        : {}),
      ...extra,
    },
  } as Update);
}
async function press(data: string, from = admin.user) {
  const before = calls.filter((c) => c.method === "answerCallbackQuery").length;
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from,
      chat_instance: "x",
      data,
      message: {
        message_id: 100,
        date: 0,
        chat: privateChat,
        from: botInfo,
        text: "Old menu",
      },
    },
  });
  expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(
    before + 1,
  );
}
const lastMenu = () =>
  calls
    .filter((c) => ["sendMessage", "editMessageText"].includes(c.method))
    .at(-1)!.payload;
const settings = async () => (await loadChat(db, -1))!.settings;
const step = async (key: string) => {
  const i = controls.findIndex((c) => c.key === key);
  await press(callback(-1, controls[i]!.screen, "cycle", String(i)));
};
it("group command is silent for non-admins and gives admins a private URL", async () => {
  await message("/settings", group, user);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  expect(
    (await db.query("SELECT * FROM managed_chats WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
  await message("/settings", group);
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  expect(lastMenu().reply_markup).toEqual(
    new (await import("grammy")).InlineKeyboard().url(
      "Open settings in private",
      "https://t.me/r9k_test_bot?start=s_-1",
    ),
  );
  expect(
    (await db.query("SELECT user_id FROM managed_chats WHERE chat_id=$1", [-1]))
      .rows,
  ).toEqual([{ user_id: 20 }]);
  expect(calls.some((c) => c.method === "deleteMessage")).toBe(false);
});
it("opens deep links and private directory with zero, one and multiple chats", async () => {
  await message("/settings");
  expect(lastMenu().text).toContain("Run /settings in a group");
  await message("/start s_-1");
  expect(lastMenu().text).toContain("Test chat");
  await message("/settings");
  expect(lastMenu().text).toContain("Preset: Relaxed");
  await saveChat(
    db,
    { ...group, id: -2 },
    { admin: true, deleteMessages: true, restrictMembers: true },
    now,
  );
  secondChatAdmin = true;
  await db.query(
    "INSERT INTO managed_chats(user_id,chat_id) VALUES($1,$2)",
    [20, -2],
  );
  await message("/settings");
  expect(lastMenu().text).toBe("Choose a chat:");
  expect(
    (lastMenu().reply_markup as InlineKeyboardMarkup).inline_keyboard.flat(),
  ).toEqual([
    { text: "Test chat", callback_data: callback(-2, "main") },
    { text: "Test chat", callback_data: callback(-1, "main") },
  ]);
  secondChatAdmin = false;
  makeBot(); // A fresh cache observes revoked access to the second group.
  await message("/settings");
  expect(
    (await db.query("SELECT user_id FROM managed_chats WHERE chat_id=$1", [-2]))
      .rows,
  ).toHaveLength(0);
  expect(lastMenu().text).toContain("Preset: Relaxed");
});
it("renders every screen in place and handles unchanged messages", async () => {
  for (const screen of screens) {
    await press(callback(-1, screen));
    expect(lastMenu().text).toContain("Test chat");
    expect(
      (lastMenu().reply_markup as InlineKeyboardMarkup).inline_keyboard
        .flat()
        .some((b) => b.text === "Back"),
    ).toBe(true);
  }
  expect(calls.filter((c) => c.method === "editMessageText")).toHaveLength(
    screens.length,
  );
  failEdit = true;
  await press(callback(-1, "main"));
  expect(errors).not.toHaveBeenCalled();
});
it("rejects tampered chat IDs and revocation after membership invalidation", async () => {
  await message("/start s_-1");
  const before = await settings();
  await press(callback(-2, "penalties", "cycle", "1"));
  await press(callback(-1, "penalties", "cycle", "1"), user);
  expect(await settings()).toEqual(before);
  expect(lastMenu().text).toBe("You are no longer an admin of that chat");
  currentAdmins = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    chat_member: {
      chat: group,
      from: admin.user,
      date: 0,
      old_chat_member: admin,
      new_chat_member: { status: "member", user: admin.user },
    },
  });
  await press(callback(-1, "penalties", "cycle", "1"));
  expect(await settings()).toEqual(before);
  expect(
    (await db.query("SELECT user_id FROM managed_chats WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await db.query("SELECT * FROM actions WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
});
it("refuses changes when the bot has left", async () => {
  await message("/start s_-1");
  botMember = { status: "left", user: botInfo };
  await step("warnStrikes");
  expect(lastMenu().text).toContain("no longer in");
  expect((await settings()).warnStrikes).toBe(2);
  expect(
    (await db.query("SELECT * FROM managed_chats WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
});
it("persists controls and audits keys with old and new values; engine reads updates", async () => {
  await step("warnStrikes");
  expect((await settings()).warnStrikes).toBe(3);
  await step("detectForwards");
  expect((await settings()).detectForwards).toBe(false);
  await step("lowEffort.emojiOnly");
  expect((await settings()).lowEffort.emojiOnly).toBe(true);
  await message("😀", group, user);
  expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
  const rows = (
    await db.query(
      "SELECT rule,detail FROM actions WHERE chat_id=$1 AND action=$2 ORDER BY id",
      [-1, "settings_change"],
    )
  ).rows;
  expect(rows[0]).toEqual({
    rule: "warnStrikes",
    detail: { key: "warnStrikes", old: 2, new: 3 },
  });
  await press(callback(-1, "main"));
  expect(lastMenu().text).toContain("Preset: Custom");
});
it("cycles all controls through their choices without invalid settings", async () => {
  for (const [index, c] of controls.entries()) {
    for (let i = 0; i < c.choices.length; i++)
      await press(callback(-1, c.screen, "cycle", String(index)));
  }
  expect(errors).not.toHaveBeenCalled();
  expect((await settings()).stickers.mode).toBe("relaxed");
});
it("presets confirm before replacing options and keep phrases", async () => {
  await changeSettings(db, -1, 20, 0, now, "allowPhrases", (s) => ({
    ...s,
    allowPhrases: ["hello"],
  }));
  await press(callback(-1, "preset", "confirm", "classic"));
  expect(lastMenu().text).toContain("Apply classic?");
  expect((await settings()).warnStrikes).toBe(2);
  await press(callback(-1, "preset", "apply", "classic"));
  expect(await settings()).toEqual({ ...classic, allowPhrases: ["hello"] });
  await press(callback(-1, "main"));
  expect(lastMenu().text).toContain("Preset: Classic");
  await press(callback(-1, "exempt", "remove", phraseId("hello")));
  await press(callback(-1, "main"));
  expect(lastMenu().text).toContain("Preset: Classic");
});
it("adds phrases using a bot ForceReply prompt across restart and safely removes old entries", async () => {
  await press(callback(-1, "exempt", "add"));
  const prompt = lastMenu();
  expect(prompt.reply_markup).toMatchObject({ force_reply: true });
  expect(prompt.text).toContain("Test chat");
  expect(prompt.text).toContain("#-1");
  makeBot();
  const reply = {
    message_id: 100,
    date: 0,
    chat: privateChat,
    from: botInfo,
    text: prompt.text,
  };
  await message("hello", privateChat, admin.user, { reply_to_message: reply });
  await message("world", privateChat, admin.user, { reply_to_message: reply });
  expect((await settings()).allowPhrases).toEqual(["hello", "world"]);
  await press(callback(-1, "exempt", "remove", phraseId("hello")));
  await press(callback(-1, "exempt", "remove", phraseId("hello")));
  expect((await settings()).allowPhrases).toEqual(["world"]);
  await message("x".repeat(201), privateChat, admin.user, {
    reply_to_message: reply,
  });
  expect((await settings()).allowPhrases).toEqual(["world"]);
  await message("forged", privateChat, admin.user, {
    reply_to_message: { ...reply, from: user },
  });
  expect((await settings()).allowPhrases).toEqual(["world"]);
  currentAdmins = [];
  makeBot();
  await message("denied", privateChat, admin.user, { reply_to_message: reply });
  expect((await settings()).allowPhrases).toEqual(["world"]);
});
it("enforces the phrase count limit and paginates long phrases", async () => {
  const phrases = Array.from(
    { length: 50 },
    (_, i) => String(i) + "😀".repeat(195),
  );
  await changeSettings(db, -1, 20, 0, now, "allowPhrases", (s) => ({
    ...s,
    allowPhrases: phrases,
  }));
  await press(callback(-1, "exempt", "add"));
  const prompt = lastMenu().text;
  await message("one too many", privateChat, admin.user, {
    reply_to_message: {
      message_id: 100,
      date: 0,
      chat: privateChat,
      from: botInfo,
      text: prompt,
    },
  });
  expect(lastMenu().text).toContain("50 allow-phrases");
  await press(callback(-1, "exempt", "show", "9"));
  expect(String(lastMenu().text).length).toBeLessThan(4096);
  expect(lastMenu().text).toContain("page 10");
  expect((await settings()).allowPhrases).toHaveLength(50);
});
it("reset requires confirmation and clears only the selected chat", async () => {
  await saveChat(
    db,
    { ...group, id: -2 },
    { admin: true, deleteMessages: true, restrictMembers: true },
    now,
  );
  for (const id of [-1, -2])
    await db.query(
      "INSERT INTO strikes(chat_id,user_id,level,updated_at) VALUES($1,10,4,$2)",
      [id, now],
    );
  await press(callback(-1, "reset", "confirm"));
  expect(
    (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(1);
  await press(callback(-1, "reset", "clear"));
  expect(
    (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
  expect(
    (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-2])).rows,
  ).toHaveLength(1);
});
it("keeps callbacks within 64 bytes including phrase removal and confirmations", () => {
  const s = { ...relaxed, allowPhrases: ["x".repeat(200)] };
  for (const screen of screens)
    for (const confirm of [false, true]) {
      const menu = renderMenu(
        -12345678901234,
        "Title",
        s,
        screen,
        "classic",
        confirm,
      );
      for (const b of menu.reply_markup.inline_keyboard.flat())
        if ("callback_data" in b)
          expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
});
it("rejects invalid centralized writes atomically", async () => {
  await expect(
    changeSettings(db, -1, 20, 0, now, "warnStrikes", (s) => ({
      ...s,
      warnStrikes: -1,
    })),
  ).rejects.toThrow("Invalid settings change");
  expect(await settings()).toEqual(relaxed);
  expect(
    (await db.query("SELECT * FROM actions WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
});

it("handles long chat IDs and rejects malformed callbacks without mutation", async () => {
  for (const screen of screens) {
    await press(callback(-12345678901234, screen));
    for (const b of (
      lastMenu().reply_markup as InlineKeyboardMarkup
    ).inline_keyboard.flat())
      if ("callback_data" in b)
        expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  }
  await press("s:bogus:main:show:");
  await press(callback(-1, "memory", "cycle", "1")); // Control belongs to another screen.
  await press(callback(-1, "preset", "apply", "constructor"));
  expect(await settings()).toEqual(relaxed);
  expect(errors).not.toHaveBeenCalled();
});

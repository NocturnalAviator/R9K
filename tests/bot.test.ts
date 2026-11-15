import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { Update, UserFromGetMe, Message, ChatMember } from "grammy/types";
import { createBot } from "../src/bot.js";
import { pgliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { saveChat } from "../src/db/chats.js";
import { relaxed, classic } from "../src/settings/presets.js";
const db = pgliteDb();
const now = new Date("2026-01-01T00:00:00Z");
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
const config = {
  BOT_TOKEN: "999:fake",
  PRIVACY_URL: "https://example.org/privacy",
  PGLITE_DIR: ".data/pglite",
  LOG_LEVEL: "silent" as const,
};
const logger = pino({ level: "silent" });
const calls: { method: string; payload: Record<string, unknown> }[] = [];
let failures = new Set<string>();
let groupType: "group" | "supergroup" = "supergroup";
let updateId = 0;
let bot: ReturnType<typeof createBot>;
beforeAll(() => migrate(db));
afterAll(() => db.close());
beforeEach(async () => {
  await db.query("DELETE FROM chats WHERE chat_id=$1", [-1]);
  await db.query("DELETE FROM chats WHERE chat_id=$1", [-2]);
  await saveChat(
    db,
    { id: -1, type: "supergroup" },
    { admin: true, deleteMessages: true, restrictMembers: true },
    now,
  );
  calls.length = 0;
  failures = new Set();
  groupType = "supergroup";
  updateId = 0;
  bot = createBot({ db, config, logger, clock: () => now, botInfo });
  bot.api.config.use(async (_prev, method, payload) => {
    const data = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: data });
    if (
      failures.has(method) ||
      (failures.has("ephemeral") && data.ephemeral_message_parameters)
    )
      return { ok: false, error_code: 400, description: "simulated failure" };
    if (method === "getChatAdministrators")
      return { ok: true, result: [admin] } as never;
    if (method === "getChatMember")
      return { ok: true, result: botAdmin } as never;
    return { ok: true, result: true } as never;
  });
});
async function message(
  id: number,
  text: string,
  extra: Partial<Message.TextMessage> = {},
  edit = false,
): Promise<void> {
  const m = {
    message_id: id,
    date: +now / 1000,
    chat: { id: -1, type: groupType, title: "Test" },
    from: user,
    text,
    ...extra,
  } as Message.TextMessage;
  await bot.handleUpdate({
    update_id: ++updateId,
    ...(edit ? { edited_message: m } : { message: m }),
  } as Update);
}
const methods = () =>
  calls
    .filter((c) => c.method !== "getChatAdministrators")
    .map((c) => c.method);
it("warns twice, deletes, mutes and sends only ephemeral notices", async () => {
  await message(1, "hello");
  for (let id = 2; id <= 5; id++) await message(id, "hello");
  expect(methods()).toEqual([
    "setMessageReaction",
    "sendMessage",
    "setMessageReaction",
    "sendMessage",
    "deleteMessage",
    "sendMessage",
    "deleteMessage",
    "restrictChatMember",
    "sendMessage",
  ]);
  const notices = calls.filter((c) => c.method === "sendMessage");
  expect(
    notices.every(
      (c) => c.payload.chat_id === -1 && !("receiver_user_id" in c.payload),
    ),
  ).toBe(true);
  expect(
    notices.every(
      (c) =>
        (c.payload.ephemeral_message_parameters as { receiver_user_id: number })
          .receiver_user_id === 10,
    ),
  ).toBe(true);
  expect(
    calls.find((c) => c.method === "restrictChatMember")?.payload,
  ).toMatchObject({
    until_date: +now / 1000 + 60,
    permissions: { can_send_messages: false, can_send_photos: false },
    use_independent_chat_permissions: true,
  });
  expect(
    calls.filter((c) => c.method === "getChatAdministrators"),
  ).toHaveLength(1);
});
it("clamps classic two-second restrictions to at least 40 seconds", async () => {
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify(classic),
  ]);
  await message(1, "hello");
  await message(2, "hello");
  expect(
    calls.find((c) => c.method === "restrictChatMember")?.payload.until_date,
  ).toBe(+now / 1000 + 40);
  expect(
    (await db.query("SELECT detail FROM actions WHERE chat_id=$1", [-1]))
      .rows[0]?.detail,
  ).toMatchObject({ muteSeconds: 2 });
});
it("never restricts in basic groups", async () => {
  groupType = "group";
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify(classic),
  ]);
  await message(1, "hello");
  await message(2, "hello");
  expect(methods()).toEqual(["deleteMessage", "sendMessage"]);
});
it("falls back to a private notice and silently gives up if it fails", async () => {
  failures.add("ephemeral");
  await message(1, "hello");
  await message(2, "hello");
  expect(
    calls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload.chat_id),
  ).toEqual([-1, 10]);
  failures.add("sendMessage");
  await expect(message(3, "hello")).resolves.toBeUndefined();
  expect(
    calls.filter((c) => c.method === "sendMessage").at(-1)?.payload.chat_id,
  ).toBe(10);
});
it("ignores commands, bots, anonymous admins, forwards and services", async () => {
  await message(1, "/unknown");
  await message(2, "hello", {
    sender_chat: { id: -1, type: "supergroup", title: "Test" },
  });
  await message(3, "hello", { from: { ...user, is_bot: true } });
  await message(4, "hello", { is_automatic_forward: true });
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: 5,
      date: +now / 1000,
      chat: { id: -1, type: "supergroup", title: "Test" },
      from: user,
      new_chat_members: [user],
    },
  });
  expect(calls).toHaveLength(0);
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
});
it("does nothing without delete rights", async () => {
  await saveChat(
    db,
    { id: -1, type: "supergroup" },
    { admin: true, deleteMessages: false, restrictMembers: true },
    now,
  );
  await message(1, "hello");
  expect(calls).toHaveLength(0);
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
});
it("failed deletion does not block restriction or notice", async () => {
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify(classic),
  ]);
  failures.add("deleteMessage");
  await message(1, "hello");
  await expect(message(2, "hello")).resolves.toBeUndefined();
  expect(methods()).toEqual([
    "deleteMessage",
    "restrictChatMember",
    "sendMessage",
  ]);
});
it("handles edits through handleUpdate without double strikes", async () => {
  await message(1, "hello");
  await message(2, "unique");
  await message(2, "hello", {}, true);
  await message(2, "HELLO!", {}, true);
  expect(methods()).toEqual(["setMessageReaction", "sendMessage"]);
});
async function membership(
  member: ChatMember,
  old: ChatMember = { status: "left", user: botInfo },
): Promise<void> {
  await bot.handleUpdate({
    update_id: ++updateId,
    my_chat_member: {
      chat: { id: -1, type: groupType, title: "Test" },
      from: user,
      date: +now / 1000,
      old_chat_member: old,
      new_chat_member: member,
    },
  });
}
it("onboards with missing rights and records removal", async () => {
  groupType = "group";
  await membership({ status: "member", user: botInfo });
  expect(calls[0]?.payload.text).toMatch(
    /Missing rights: admin, delete messages, restrict members/,
  );
  expect(calls[0]?.payload.text).toMatch(/Muting needs a supergroup/);
  calls.length = 0;
  await membership({ status: "left", user: botInfo }, botAdmin);
  expect(calls).toHaveLength(0);
  expect(
    (await db.query("SELECT removed_at FROM chats WHERE chat_id=$1", [-1]))
      .rows[0]?.removed_at,
  ).toEqual(now);
});
it("invalidates the admin cache on chat_member updates", async () => {
  await message(1, "one");
  await bot.handleUpdate({
    update_id: ++updateId,
    chat_member: {
      chat: { id: -1, type: "supergroup", title: "Test" },
      from: user,
      date: +now / 1000,
      old_chat_member: admin,
      new_chat_member: admin,
    },
  });
  await message(2, "two");
  expect(
    calls.filter((c) => c.method === "getChatAdministrators"),
  ).toHaveLength(2);
});
it("expires the admin cache after ten minutes", async () => {
  const clock = vi.fn(() => now);
  bot = createBot({ db, config, logger, clock, botInfo });
  let fetches = 0;
  bot.api.config.use(async () => {
    fetches++;
    return { ok: true, result: [] } as never;
  });
  await message(1, "one");
  clock.mockReturnValue(new Date(+now + 600001));
  await message(2, "two");
  expect(fetches).toBe(2);
});
it("commands respond without recording text", async () => {
  for (const command of ["start", "status", "privacy", "help"])
    await message(++updateId, "/" + command, {
      entities: [
        { type: "bot_command", offset: 0, length: command.length + 1 },
      ],
    });
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(4);
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
});
it("handles group migration updates", async () => {
  await message(1, "hello");
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: 2,
      date: +now / 1000,
      chat: { id: -1, type: "group", title: "Test" },
      from: user,
      migrate_to_chat_id: -2,
    },
  });
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-2]))
      .rows,
  ).toHaveLength(1);
});
it("does not leak message text through update errors", async () => {
  failures.add("getChatAdministrators");
  await expect(message(1, "secret text")).resolves.toBeUndefined();
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
});
it("disables muting of admins even when their exemption is off", async () => {
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify({ ...classic, exemptAdmins: false }),
  ]);
  await message(1, "hello");
  await message(2, "hello", { from: admin.user });
  expect(methods()).toEqual(["deleteMessage", "sendMessage"]);
});
it("retains settings when rights change", async () => {
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify(classic),
  ]);
  await membership(botAdmin);
  expect(
    (await db.query("SELECT settings FROM chats WHERE chat_id=$1", [-1]))
      .rows[0]?.settings,
  ).toEqual(classic);
  expect(relaxed.memorySeconds).toBe(86400);
});

async function content(
  id: number,
  extra: Record<string, unknown>,
  userId = 10,
) {
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: id,
      date: +now / 1000,
      chat: { id: -1, type: "supergroup", title: "Test" },
      from: { ...user, id: userId },
      ...extra,
    },
  } as Update);
}
it("handles re-sent photos without text and chooses the largest size", async () => {
  await content(1, {
    photo: [
      { file_id: "small", file_unique_id: "s1", width: 10, height: 10 },
      { file_id: "large", file_unique_id: "large", width: 100, height: 100 },
    ],
  });
  await content(2, {
    photo: [
      { file_id: "small", file_unique_id: "s2", width: 10, height: 10 },
      { file_id: "large", file_unique_id: "large", width: 100, height: 100 },
    ],
  });
  expect(methods()).toEqual(["setMessageReaction", "sendMessage"]);
  expect(calls.find((c) => c.method === "sendMessage")?.payload.text).toContain(
    "this media",
  );
});
it("detects forwarded channel posts without text", async () => {
  const forward_origin = {
    type: "channel",
    date: +now / 1000,
    chat: { id: -100, type: "channel", title: "Source" },
    message_id: 42,
  };
  await content(1, { forward_origin });
  await content(2, { forward_origin });
  expect(methods()).toEqual(["setMessageReaction", "sendMessage"]);
  expect(calls.find((c) => c.method === "sendMessage")?.payload.text).toContain(
    "this forward",
  );
});
it("deletes sticker spam without restricting the user", async () => {
  const sticker = {
    file_id: "s",
    file_unique_id: "s",
    type: "regular",
    width: 100,
    height: 100,
    is_animated: false,
    is_video: false,
  };
  await content(1, { sticker });
  await content(2, { sticker });
  expect(methods()).toEqual(["deleteMessage", "sendMessage"]);
  expect(calls.find((c) => c.method === "sendMessage")?.payload.text).toContain(
    "Sticker limit",
  );
});
it("collapses a two-user chain without notices or restrictions", async () => {
  await content(1, { text: "hello" }, 10);
  await content(2, { text: "hello" }, 11);
  expect(methods()).toEqual(["deleteMessage"]);
});

it("commands and service messages reset the sticker run", async () => {
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify({
      ...relaxed,
      stickers: {
        mode: "custom",
        budget: 10,
        windowSeconds: 60,
        maxConsecutive: 1,
        cooldownSeconds: 0,
      },
    }),
  ]);
  const sticker = {
    file_id: "s",
    file_unique_id: "s",
    type: "regular",
    width: 100,
    height: 100,
    is_animated: false,
    is_video: false,
  };
  await content(1, { sticker });
  await message(2, "/unknown");
  await content(3, { sticker });
  await content(4, { new_chat_members: [user] });
  await content(5, { sticker });
  expect(methods()).toEqual([]);
});

async function command(name: string, extra: Partial<Message.TextMessage> = {}) {
  await message(++updateId, `/${name}`, {
    entities: [{ type: "bot_command", offset: 0, length: name.length + 1 }],
    ...extra,
  });
}
it("me and top are public replies, top is chat-rate-limited and me shows decay", async () => {
  await message(1, "first");
  await message(2, "second");
  await message(3, "first");
  await command("me");
  let response = calls.filter((c) => c.method === "sendMessage").at(-1)!;
  expect(response.payload.text).toContain(
    "originals: 66.7%".replace("originals", "originality"),
  );
  expect(response.payload.text).toContain(
    "streak: 0; best streak: 2; strike level: 1.00",
  );
  expect(response.payload.reply_parameters).toBeDefined();
  expect(response.payload.ephemeral_message_parameters).toBeUndefined();
  await db.query(
    "UPDATE strikes SET updated_at=$3 WHERE chat_id=$1 AND user_id=$2",
    [-1, 10, new Date(+now - 21600000)],
  );
  await command("me");
  expect(
    calls.filter((c) => c.method === "sendMessage").at(-1)?.payload.text,
  ).toContain("strike level: 0.50");
  calls.length = 0;
  await command("top");
  await command("top");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  response = calls.filter((c) => c.method === "sendMessage")[0]!;
  expect(response.payload.text).toContain("Tester");
  expect(response.payload.ephemeral_message_parameters).toBeUndefined();
  await db.query("UPDATE chats SET last_top_at=$2 WHERE chat_id=$1", [
    -1,
    new Date(+now - 60000),
  ]);
  await command("top");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(2);
});
it("why self and admin replies show bounded quotes and expired text, non-admin sees only self", async () => {
  const original = "some lengthy original ".repeat(20);
  await message(1, original);
  for (let i = 2; i <= 7; i++) await message(i, original);
  calls.length = 0;
  await command("why");
  let response = calls.find((c) => c.method === "sendMessage")!;
  expect(response.payload.text).toContain("Repeated text");
  expect(response.payload.text).toContain("2026-01-01");
  expect(response.payload.text).not.toContain(original);
  expect(response.payload.ephemeral_message_parameters).toEqual({
    receiver_user_id: 10,
  });
  const reply = {
    reply_to_message: undefined,
    message_id: 1,
    date: +now / 1000,
    chat: { id: -1, type: "supergroup" as const, title: "Test" },
    from: user,
    text: original,
  };
  calls.length = 0;
  await command("why", { from: admin.user, reply_to_message: reply });
  response = calls.find((c) => c.method === "sendMessage")!;
  expect(String(response.payload.text).split("\n\n")).toHaveLength(5);
  expect(response.payload.ephemeral_message_parameters).toEqual({
    receiver_user_id: 20,
  });
  await db.query(
    "UPDATE messages SET raw_text=NULL,normalized_text=NULL WHERE chat_id=$1",
    [-1],
  );
  calls.length = 0;
  await command("why", { reply_to_message: reply });
  expect(calls.find((c) => c.method === "sendMessage")?.payload.text).toContain(
    "text no longer stored",
  );
  calls.length = 0;
  await command("why", { from: { ...user, id: 30 }, reply_to_message: reply });
  expect(calls.find((c) => c.method === "sendMessage")?.payload.text).toBe(
    "No actions recorded.",
  );
});
it("forgetme group removes text and names, private requires confirmation across chats", async () => {
  await message(1, "remember");
  await command("forgetme");
  expect(
    (await db.query("SELECT raw_text FROM messages WHERE chat_id=$1", [-1]))
      .rows[0]?.raw_text,
  ).toBeNull();
  expect(
    (await db.query("SELECT * FROM users WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
  await message(2, "remember");
  expect(calls.some((c) => c.method === "setMessageReaction")).toBe(true);
  await saveChat(
    db,
    { id: -2, type: "supergroup" },
    { admin: true, deleteMessages: true, restrictMembers: true },
    now,
  );
  await message(3, "second chat", {
    chat: { id: -2, type: "supergroup", title: "Other" },
  });
  const privateChat = {
    id: 10,
    type: "private" as const,
    first_name: "Tester",
  };
  await command("forgetme", { chat: privateChat });
  expect(
    (await db.query("SELECT raw_text FROM messages WHERE chat_id=$1", [-2]))
      .rows[0]?.raw_text,
  ).toBe("second chat");
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: "confirm",
      from: user,
      chat_instance: "test",
      data: "forget:10",
      message: {
        message_id: 100,
        date: +now / 1000,
        chat: privateChat,
        from: botInfo,
        text: "Confirm",
      },
    },
  });
  expect(
    (await db.query("SELECT raw_text FROM messages WHERE chat_id=$1", [-2]))
      .rows[0]?.raw_text,
  ).toBeNull();
  expect(
    (await db.query("SELECT * FROM fingerprints WHERE chat_id=$1", [-2])).rows,
  ).toHaveLength(1);
  expect(
    calls.filter((c) => c.method === "editMessageText").at(-1)?.payload.text,
  ).toContain("Removed:");
});

it("tracks successful polling and processed updates, and alerts on boundary failures", async () => {
  const { Health } = await import("../src/operations/health.js");
  const { Alerts } = await import("../src/operations/alerts.js");
  const health = new Health(() => now);
  const alertTexts: string[] = [];
  const alerts = new Alerts(
    () => now,
    async (text) => {
      alertTexts.push(text);
    },
  );
  bot = createBot({
    db,
    config,
    logger,
    clock: () => now,
    botInfo,
    health,
    alerts,
  });
  const pollingTracker = bot.api.config.installedTransformers()[0]!;
  let broken = false;
  bot.api.config.use(async (_prev, method) => {
    if (method === "getUpdates") return { ok: true, result: [] } as never;
    if (broken) throw new Error("private payload");
    return { ok: true, result: [] } as never;
  });
  // Fake transport short-circuits inner transformers; wrap it with the real tracker.
  bot.api.config.use(pollingTracker);
  expect(await health.status(db)).toBe(503);
  await bot.api.getUpdates();
  expect(await health.status(db)).toBe(200);
  broken = true;
  await message(1, "secret");
  expect(alertTexts).toHaveLength(1);
  expect(alertTexts[0]).not.toContain("private payload");
  const updateHealth = new Health(() => now);
  bot = createBot({
    db,
    config,
    logger,
    clock: () => now,
    botInfo,
    health: updateHealth,
  });
  bot.api.config.use(async () => ({ ok: true, result: [] }) as never);
  await message(2, "original");
  expect(await updateHealth.status(db)).toBe(200);
});

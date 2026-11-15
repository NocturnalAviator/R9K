// End-to-end tests: the real bot process (src/main.ts, with its runner,
// retries, startup and jobs) talking over HTTP to a fake Telegram server,
// driven by scripted users. Nothing here touches the real Telegram API.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BOT,
  BOT_TOKEN,
  FakeTelegram,
  type Sent,
  type User,
} from "./fake-telegram.js";

let tg: FakeTelegram;
let bot: ChildProcess;
let healthPort: number;
const logs: { level: number; msg: string; err?: string }[] = [];
let nextChat = -1000000000001;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as { port: number };
  await new Promise((r) => probe.close(r));
  return port;
}
beforeAll(async () => {
  tg = await FakeTelegram.start();
  healthPort = await freePort();
  bot = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    // A fresh in-memory database and no .env: never the real bot or token.
    env: {
      PATH: process.env.PATH,
      BOT_TOKEN,
      TELEGRAM_API_ROOT: tg.url,
      PGLITE_DIR: "memory://",
      HEALTH_PORT: String(healthPort),
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffered = "";
  const read = (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines)
      try {
        logs.push(JSON.parse(line) as (typeof logs)[number]);
      } catch {
        if (line.trim()) logs.push({ level: 60, msg: line });
      }
  };
  bot.stdout!.on("data", read);
  bot.stderr!.on("data", read);
  await tg.until(
    () => tg.callsTo("setMyCommands").length === 3,
    "the bot to start and register its commands",
    30000,
  );
}, 40000);
afterAll(async () => {
  bot.kill("SIGTERM");
  await new Promise((r) => bot.once("exit", r));
  await tg.stop();
});

/** A fresh supergroup per test, so tests cannot affect each other. */
async function newGroup(title: string) {
  const owner = tg.user("Alice");
  const chat = tg.supergroup(nextChat--, title, owner);
  await tg.until(
    () => tg.visible(chat).some((m) => m.text.includes("R9K is active")),
    "the onboarding message",
  );
  return { chat, owner };
}
const botMessages = (chat: number) =>
  tg.visible(chat).filter((m) => m.from === BOT.id);
const notices = (chat: number, user: User) =>
  tg.ephemeral(chat, user).map((m) => m.text);
async function openSettings(chat: number, admin: User): Promise<Sent> {
  tg.say(chat, admin, "/settings", { ephemeral: true });
  return tg.until(
    () => tg.ephemeral(chat, admin).find((m) => m.text.includes("Preset:")),
    "the settings menu",
  );
}
/** Presses a button and waits for the menu to show `expected`; returns ms taken. */
async function press(menu: Sent, admin: User, label: string, expected: string) {
  const started = Date.now();
  tg.press(menu, admin, label);
  await tg.until(
    () => menu.text.includes(expected),
    `menu to show "${expected}"`,
  );
  return Date.now() - started;
}
async function applyClassic(chat: number, admin: User) {
  const menu = await openSettings(chat, admin);
  await press(menu, admin, "Preset", "Classic —");
  await press(menu, admin, "Classic", "Apply classic?");
  await press(menu, admin, "Confirm preset", "Classic —");
  await press(menu, admin, "« Back", "Preset: Classic");
  return menu;
}

it("starts up: command lists for each audience, healthy", async () => {
  const scopes = tg
    .callsTo("setMyCommands")
    .map((c) => (c.payload.scope as { type: string }).type);
  expect(scopes.sort()).toEqual([
    "all_chat_administrators",
    "all_group_chats",
    "all_private_chats",
  ]);
  const adminList = tg
    .callsTo("setMyCommands")
    .find(
      (c) =>
        (c.payload.scope as { type: string }).type ===
        "all_chat_administrators",
    )!.payload.commands as { command: string; is_ephemeral?: boolean }[];
  expect(adminList.find((c) => c.command === "settings")?.is_ephemeral).toBe(
    true,
  );
  // Healthy once the first poll of Telegram has completed.
  let status = 0;
  await tg.until(() => {
    void fetch(`http://127.0.0.1:${healthPort}/healthz`).then(
      (r) => (status = r.status),
    );
    return status === 200;
  }, "the healthcheck to pass");
});

it("walks a repeater up the ladder: warn, warn, delete, mute, all notices private", async () => {
  const { chat } = await newGroup("Ladder");
  const mallory = tg.user("Mallory");
  tg.say(chat, mallory, "the same old joke");

  const first = tg.say(chat, mallory, "The same old joke!!");
  await tg.until(() => first.reactions.includes("👀"), "a warning reaction");
  await tg.until(() => notices(chat, mallory).length === 1, "first notice");
  expect(notices(chat, mallory)[0]).toContain("Warning 1 of 2");
  expect(first.deleted).toBe(false);

  const second = tg.say(chat, mallory, "the same old joke");
  await tg.until(() => notices(chat, mallory).length === 2, "second notice");
  expect(notices(chat, mallory)[1]).toContain("Warning 2 of 2");
  expect(second.deleted).toBe(false);

  const third = tg.say(chat, mallory, "the same old joke");
  await tg.until(() => third.deleted, "the third repeat to be deleted");
  await tg.until(() => notices(chat, mallory).length === 3, "third notice");
  expect(notices(chat, mallory)[2]).toContain("Message removed");
  expect(tg.restrictions.filter((r) => r.chat === chat)).toHaveLength(0);

  const before = Math.floor(Date.now() / 1000);
  const fourth = tg.say(chat, mallory, "the same old joke");
  await tg.until(() => fourth.deleted, "the fourth repeat to be deleted");
  const mute = await tg.until(
    () => tg.restrictions.find((r) => r.chat === chat),
    "a mute",
  );
  expect(mute.user).toBe(mallory.id);
  expect(mute.until - before).toBeGreaterThanOrEqual(60);
  await tg.until(() => notices(chat, mallory).length === 4, "fourth notice");
  expect(notices(chat, mallory)[3]).toContain("Muted for 1 minute");

  // The group itself only ever saw the onboarding message from the bot.
  expect(botMessages(chat)).toHaveLength(1);
});

it("counts admins' posts but never penalises them; echoing an admin is collapsed", async () => {
  const { chat, owner } = await newGroup("Admins");
  const bob = tg.user("Bob");
  tg.say(chat, owner, "an announcement from the owner");
  const again = tg.say(chat, owner, "an announcement from the owner");
  const echo = tg.say(chat, bob, "an announcement from the owner");
  // Default chain handling: a quick echo by someone else is removed quietly.
  await tg.until(() => echo.deleted, "the echo to be deleted");
  await tg.settled(chat);
  expect(again.deleted).toBe(false);
  expect(again.reactions).toEqual([]);
  expect(notices(chat, owner)).toEqual([]);
  expect(notices(chat, bob)).toEqual([]);
  expect(tg.restrictions.filter((r) => r.chat === chat)).toHaveLength(0);

  tg.say(chat, owner, "/top");
  const top = await tg.until(
    () => botMessages(chat).find((m) => m.text.startsWith("Top originals")),
    "the leaderboard",
  );
  expect(top.text).toContain("1. Alice: 1");
});

it("opens settings inside the group for the admin alone, fast, and applies them", async () => {
  const { chat, owner } = await newGroup("Settings");
  const lookupsBefore =
    tg.callsTo("getChat").length + tg.callsTo("getChatMember").length;
  const menu = await openSettings(chat, owner);
  expect(menu.receiver).toBe(owner.id);
  expect(menu.text).toContain("Preset: Relaxed");

  const timings = [
    await press(menu, owner, "Preset", "Classic —"),
    await press(menu, owner, "Classic", "Apply classic?"),
    await press(menu, owner, "Confirm preset", "Classic —"),
    await press(menu, owner, "« Back", "Preset: Classic"),
    await press(menu, owner, "Penalties", "Tap to cycle values"),
    await press(menu, owner, "Mute cap", "up to 30 d"),
  ];
  // A press is one edit, with no per-press lookups against Telegram. (A
  // client-side throttler once made each press take several seconds.)
  expect(Math.max(...timings)).toBeLessThan(1500);
  expect(
    tg.callsTo("getChat").length + tg.callsTo("getChatMember").length,
  ).toBe(lookupsBefore);
  // Nothing about the menu is visible to the group.
  expect(botMessages(chat)).toHaveLength(1);

  // Classic takes effect: a repeat is deleted and muted at once, no warning.
  const bob = tg.user("Bob");
  const carol = tg.user("Carol");
  tg.say(chat, bob, "first!");
  const repeat = tg.say(chat, carol, "FIRST");
  await tg.until(() => repeat.deleted, "the repeat to be deleted");
  const mute = await tg.until(
    () => tg.restrictions.find((r) => r.chat === chat),
    "an immediate mute",
  );
  expect(mute.user).toBe(carol.id);
  // Classic's 2-second base is clamped: under 30 s Telegram mutes forever.
  expect(mute.until - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(35);
  expect(repeat.reactions).toEqual([]);

  tg.press(menu, owner, "« Back");
  await tg.until(() => menu.text.includes("Preset: Custom"), "main screen");
  tg.press(menu, owner, "Close");
  await tg.until(() => menu.deleted, "the menu to close");
});

it("ignores /settings from non-admins and hides an admin's typed command", async () => {
  const { chat, owner } = await newGroup("Gate");
  const bob = tg.user("Bob");
  const attempt = tg.say(chat, bob, "/settings");
  await tg.settled(chat);
  expect(attempt.deleted).toBe(false);
  expect(notices(chat, bob)).toEqual([]);

  const typed = tg.say(chat, owner, "/settings@r9k_e2e_bot");
  await tg.until(() => typed.deleted, "the typed command to be removed");
  await tg.until(
    () => tg.ephemeral(chat, owner).some((m) => m.text.includes("Preset:")),
    "the private menu",
  );
  expect(botMessages(chat)).toHaveLength(1);
});

it("lets an admin allow a phrase from the group", async () => {
  const { chat, owner } = await newGroup("Allow");
  tg.say(chat, owner, "/allow good morning", { ephemeral: true });
  await tg.until(
    () =>
      tg.ephemeral(chat, owner).some((m) => m.text.includes("1. good morning")),
    "the exemptions screen",
  );
  const bob = tg.user("Bob");
  const messages = [1, 2, 3, 4].map(() => tg.say(chat, bob, "Good morning!"));
  await tg.settled(chat);
  expect(messages.some((m) => m.deleted || m.reactions.length > 0)).toBe(false);
  expect(notices(chat, bob)).toEqual([]);
});

it("re-checks edits: editing a message into a repeat is penalised", async () => {
  const { chat } = await newGroup("Edits");
  const dave = tg.user("Dave");
  tg.say(chat, dave, "something original here");
  const second = tg.say(chat, dave, "a different thought");
  await tg.settled(chat);
  expect(second.reactions).toEqual([]);
  tg.edit(second, dave, "Something original here.");
  await tg.until(
    () => second.reactions.includes("👀"),
    "a warning on the edit",
  );
  expect(notices(chat, dave)[0]).toContain("Warning 1 of 2");
});

it("limits sticker runs by deleting, never by striking or muting", async () => {
  const { chat } = await newGroup("Stickers");
  const erin = tg.user("Erin");
  const sent = ["a", "b", "c", "d", "e", "f"].map((id) =>
    tg.sticker(chat, erin, id),
  );
  // Relaxed allows five stickers in a row; the sixth goes.
  await tg.until(() => sent[5]!.deleted, "the sixth sticker to be deleted");
  expect(sent.slice(0, 5).some((m) => m.deleted)).toBe(false);
  await tg.until(() => notices(chat, erin).length === 1, "a sticker notice");
  expect(notices(chat, erin)[0]).toContain("Sticker limit");
  expect(tg.restrictions.filter((r) => r.chat === chat)).toHaveLength(0);
});

it("retries when Telegram rate-limits a delete", async () => {
  const { chat } = await newGroup("Retry");
  const gina = tg.user("Gina");
  const frank = tg.user("Frank");
  tg.say(chat, gina, "retry this please");
  await tg.settled(chat);
  tg.failNext("deleteMessage", {
    ok: false,
    error_code: 429,
    description: "Too Many Requests: retry after 1",
    parameters: { retry_after: 1 },
  });
  const echo = tg.say(chat, frank, "retry this please");
  await tg.until(() => echo.deleted, "the delete to succeed on retry");
  const attempts = tg
    .callsTo("deleteMessage")
    .filter((c) => c.payload.chat_id === chat);
  expect(attempts.map((c) => c.ok)).toEqual([false, true]);
});

it("cleans up a flood promptly", async () => {
  const { chat, owner } = await newGroup("Flood");
  await applyClassic(chat, owner);
  tg.say(chat, tg.user("Seed"), "copy pasta copy pasta");
  await tg.settled(chat);
  const started = Date.now();
  const flood = Array.from({ length: 15 }, (_, i) =>
    tg.say(chat, tg.user(`Raider${i}`), "copy pasta copy pasta"),
  );
  await tg.until(
    () => flood.every((m) => m.deleted),
    "the flood to be deleted",
  );
  // Fifteen deletes and mutes must not queue behind a per-chat rate limiter.
  expect(Date.now() - started).toBeLessThan(4000);
  expect(tg.restrictions.filter((r) => r.chat === chat)).toHaveLength(15);
});

it("logged no errors during the whole run", () => {
  const problems = logs.filter(
    (l) => l.level >= 50 || l.msg === "Telegram action failed",
  );
  expect(problems).toEqual([]);
});

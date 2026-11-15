import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { pgliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { saveChat, migrateChat } from "../src/db/chats.js";
import {
  processMessage,
  type MessageInput,
} from "../src/enforce/process-message.js";
import { relaxed, classic } from "../src/settings/presets.js";
import { clearExpiredText } from "../src/db/retention.js";
const db = pgliteDb();
const now = new Date("2026-01-01T00:00:00Z");
const rights = { admin: true, deleteMessages: true, restrictMembers: true };
let id = 0;
const input = (
  text: string,
  extra: Partial<MessageInput> = {},
): MessageInput => ({
  chatId: -1,
  messageId: ++id,
  userId: 10,
  text,
  settings: relaxed,
  isEdit: false,
  userIsAdmin: false,
  canMute: true,
  ...extra,
});
beforeAll(async () => {
  await migrate(db);
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  for (const chatId of [-1, -2, -3])
    await db.query("DELETE FROM chats WHERE chat_id=$1", [chatId]);
  await saveChat(db, { id: -1, type: "supergroup" }, rights, now);
  await saveChat(db, { id: -2, type: "supergroup" }, rights, now);
  id = 0;
});
it("loads pg_trgm and returns bigint ids as numbers", async () => {
  expect(
    (
      await db.query<{ n: number }>(
        "SELECT chat_id AS n FROM chats WHERE chat_id=$1",
        [-1],
      )
    ).rows[0]?.n,
  ).toBe(-1);
  expect(
    (await db.query<{ s: number }>("SELECT similarity('hello','hello') AS s"))
      .rows[0]?.s,
  ).toBe(1);
});
it("matches own repeats, scopes by chat and records audit/stats", async () => {
  expect((await processMessage(db, input("hello"), now)).action).toBe("none");
  const v = await processMessage(db, input("HELLO!"), now);
  expect(v).toMatchObject({
    action: "warn",
    strike: 1,
    matchedMessageId: 1,
    rule: "exact_text",
  });
  expect(
    (await processMessage(db, input("hello", { chatId: -2 }), now)).action,
  ).toBe("none");
  expect(
    (
      await db.query(
        "SELECT originals,repeats FROM stats WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toEqual([{ originals: 1, repeats: 1 }]);
  expect(
    (await db.query("SELECT detail FROM actions WHERE chat_id=$1", [-1]))
      .rows[0]?.detail,
  ).toMatchObject({ strike: 1 });
});
it("uses current window and original created timestamp", async () => {
  await processMessage(db, input("hello"), now);
  expect(
    (await processMessage(db, input("hello"), new Date(+now + 86400001)))
      .action,
  ).toBe("none");
  expect(
    (
      await processMessage(
        db,
        input("hello", { settings: classic }),
        new Date(+now + 1e12),
      )
    ).action,
  ).toBe("mute");
});
it("handles exemptions: admins are stored but never penalised", async () => {
  for (const i of [
    input("!!!"),
    input("Allowed!", { settings: { ...relaxed, allowPhrases: ["allowed"] } }),
  ])
    expect((await processMessage(db, i, now)).action).toBe("none");
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
  // An exempt admin's message enters the corpus and counts as an original.
  const adminInput = input("hello", { userIsAdmin: true });
  expect((await processMessage(db, adminInput, now)).action).toBe("none");
  expect(
    (
      await db.query(
        "SELECT originals FROM stats WHERE chat_id=$1 AND user_id=$2",
        [-1, adminInput.userId],
      )
    ).rows,
  ).toEqual([{ originals: 1 }]);
  // The admin repeating it is not penalised and leaves no trace.
  expect(
    (
      await processMessage(
        db,
        { ...adminInput, messageId: adminInput.messageId + 1000 },
        now,
      )
    ).action,
  ).toBe("none");
  expect(
    (await db.query("SELECT * FROM strikes WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
  await processMessage(db, input("hello"), now);
  expect(
    (
      await processMessage(
        db,
        input("hello", {
          userIsAdmin: true,
          settings: { ...relaxed, exemptAdmins: false },
        }),
        now,
      )
    ).action,
  ).toBe("warn");
});
it("penalizes edits into repeats once and removes obsolete fingerprints", async () => {
  await processMessage(db, input("first", { messageId: 1 }), now);
  await processMessage(db, input("second", { messageId: 2 }), now);
  expect(
    (
      await processMessage(
        db,
        input("first", { messageId: 2, isEdit: true }),
        now,
      )
    ).strike,
  ).toBe(1);
  expect(
    (
      await processMessage(
        db,
        input("first!!", { messageId: 2, isEdit: true }),
        now,
      )
    ).action,
  ).toBe("none");
  expect(
    (await processMessage(db, input("second", { messageId: 3 }), now)).action,
  ).toBe("none");
  expect(
    (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-1])).rows[0]
      ?.level,
  ).toBe(1);
});
it("replaces originals on edit, excluding self", async () => {
  await processMessage(db, input("old", { messageId: 1 }), now);
  expect(
    (
      await processMessage(
        db,
        input("old", { messageId: 1, isEdit: true }),
        now,
      )
    ).action,
  ).toBe("none");
  await processMessage(db, input("new", { messageId: 1, isEdit: true }), now);
  expect(
    (await processMessage(db, input("old", { messageId: 2 }), now)).action,
  ).toBe("none");
  expect(
    (await processMessage(db, input("new", { messageId: 3 }), now)).action,
  ).toBe("warn");
});
it("escalates and decays in the database", async () => {
  await processMessage(db, input("hello"), now);
  const results = [];
  for (let i = 0; i < 5; i++)
    results.push(await processMessage(db, input("hello"), now));
  expect(results.map((v) => v.action)).toEqual([
    "warn",
    "warn",
    "delete",
    "mute",
    "mute",
  ]);
  expect(results.slice(3).map((v) => v.muteSeconds)).toEqual([60, 240]);
  expect(
    (await processMessage(db, input("hello"), new Date(+now + 21600000)))
      .strike,
  ).toBe(3);
});
it("moves all chat data through cascading keys, including audit references", async () => {
  await processMessage(db, input("hello"), now);
  await processMessage(db, input("hello"), now);
  await migrateChat(db, -1, -3);
  for (const table of [
    "messages",
    "fingerprints",
    "strikes",
    "actions",
    "stats",
  ]) {
    expect(
      (await db.query(`SELECT chat_id FROM ${table} WHERE chat_id=$1`, [-1]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await db.query(`SELECT chat_id FROM ${table} WHERE chat_id=$1`, [-3]))
        .rows.length,
    ).toBeGreaterThan(0);
  }
});
it("rolls back transactions", async () => {
  await expect(
    db.tx(async (tx) => {
      await tx.query("DELETE FROM chats WHERE chat_id=$1", [-1]);
      throw Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(
    (await db.query("SELECT chat_id FROM chats WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(1);
});
it("erases expired raw and normalized text but preserves forever fingerprints", async () => {
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify(classic),
  ]);
  await processMessage(db, input("hello", { settings: classic }), now);
  await clearExpiredText(db, -1, new Date(+now + 90 * 86400000));
  expect(
    (
      await db.query(
        "SELECT raw_text,normalized_text FROM messages WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toEqual([{ raw_text: null, normalized_text: null }]);
  expect(
    (
      await processMessage(
        db,
        input("hello", { settings: classic }),
        new Date(+now + 91 * 86400000),
      )
    ).action,
  ).toBe("mute");
});

it("a shorter current memory window immediately makes old text postable", async () => {
  await processMessage(db, input("hello"), now);
  const later = new Date(+now + 2000);
  expect(
    (
      await processMessage(
        db,
        input("hello", { settings: { ...relaxed, memorySeconds: 1 } }),
        later,
      )
    ).action,
  ).toBe("none");
});
it("concurrent calls in one chat produce one original", async () => {
  const results = await Promise.all([
    processMessage(db, input("hello"), now),
    processMessage(db, input("hello"), now),
  ]);
  expect(results.map((v) => v.action).sort()).toEqual(["none", "warn"]);
});

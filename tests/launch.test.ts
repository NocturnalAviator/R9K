import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { pgliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { saveChat } from "../src/db/chats.js";
import { processMessage } from "../src/enforce/process-message.js";
import { classic, relaxed } from "../src/settings/presets.js";
import { forget, purgeRemoved } from "../src/db/privacy.js";
import { retainChat } from "../src/db/retention.js";
import { postWeekly, top, weekStart } from "../src/stats/scores.js";
import { Health } from "../src/operations/health.js";
import { Alerts } from "../src/operations/alerts.js";
const db = pgliteDb();
const now = new Date("2026-11-09T10:00:00Z");
const rights = { admin: true, deleteMessages: true, restrictMembers: true };
beforeAll(() => migrate(db));
afterAll(() => db.close());
beforeEach(async () => {
  for (const id of [-1, -2]) {
    await db.query("DELETE FROM chats WHERE chat_id=$1", [id]);
    await saveChat(db, { id, type: "supergroup" }, rights, now);
  }
});
const run = (
  id: number,
  text: string,
  userId = 10,
  date = now,
  settings = classic,
  isEdit = false,
  chatId = -1,
) =>
  processMessage(
    db,
    {
      chatId,
      messageId: id,
      userId,
      text,
      settings,
      isEdit,
      userIsAdmin: false,
      canMute: true,
    },
    date,
  );
const stats = async () =>
  (
    await db.query(
      "SELECT originals,repeats,streak,best_streak FROM stats WHERE chat_id=$1 AND user_id=$2",
      [-1, 10],
    )
  ).rows[0];
it("scores streaks and original-week edits, ignoring no-strike events", async () => {
  await run(1, "first");
  await run(2, "second");
  await run(3, "third");
  expect(await stats()).toEqual({
    originals: 3,
    repeats: 0,
    streak: 3,
    best_streak: 3,
  });
  await run(4, "third");
  await run(5, "fourth");
  expect(await stats()).toEqual({
    originals: 4,
    repeats: 1,
    streak: 1,
    best_streak: 3,
  });
  await run(5, "fourth!", 10, new Date(+now + 7 * 86400000), classic, true);
  expect(await stats()).toEqual({
    originals: 4,
    repeats: 1,
    streak: 1,
    best_streak: 3,
  });
  await run(4, "unique", 10, new Date(+now + 7 * 86400000), classic, true);
  expect(await stats()).toEqual({
    originals: 5,
    repeats: 0,
    streak: 5,
    best_streak: 5,
  });
  expect(
    (
      await db.query(
        "SELECT originals,repeats,week_start::text FROM stats_weekly WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toEqual([{ originals: 5, repeats: 0, week_start: "2026-11-09" }]);
  await run(6, "unique", 11, now, relaxed); // chain, no score
  expect(
    (
      await db.query(
        "SELECT user_id FROM stats WHERE chat_id=$1 AND user_id=$2",
        [-1, 11],
      )
    ).rows,
  ).toHaveLength(0);
  await run(7, "x", 10, now, {
    ...classic,
    lowEffort: { ...classic.lowEffort, minLength: 3 },
  });
  expect((await stats())?.streak).toBe(5);
});
it("orders top by originals then rate, strips mentions and caps at ten", async () => {
  for (let u = 10; u < 22; u++) {
    await run(u, `unique ${u}`, u);
    await db.query(
      "INSERT INTO users(chat_id,user_id,first_name,username,updated_at) VALUES($1,$2,$3,$4,$5)",
      [-1, u, `@Name${u}`, "@handle", now],
    );
  }
  await run(30, "unique 10", 10);
  const output = await top(db, -1, weekStart(now));
  expect(output).not.toContain("@");
  expect(output.split("\n")).toHaveLength(11);
  expect(output.split("\n")[1]).toContain("Name11");
  expect(output).not.toContain("Name10:");
});
it("weekly job defaults off and persists the claim across calls and restarts", async () => {
  const send = vi.fn(async () => {});
  await postWeekly(db, now, send);
  expect(send).not.toHaveBeenCalled();
  await db.query("UPDATE chats SET settings=$2 WHERE chat_id=$1", [
    -1,
    JSON.stringify({ ...classic, leaderboard: { weekly: true } }),
  ]);
  await postWeekly(db, new Date("2026-11-09T08:59:00Z"), send);
  expect(send).not.toHaveBeenCalled();
  await postWeekly(db, now, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toEqual([
    -1,
    expect.stringContaining("2026-11-02"),
  ]);
  await postWeekly(db, now, async () => {
    throw new Error("should not send");
  });
});
it("forget clears personal text, caches and helpers but keeps repeat detection and strikes", async () => {
  await run(1, "forgotten");
  await run(2, "forgotten");
  await run(3, "other chat", 10, now, classic, false, -2);
  await db.query("INSERT INTO users VALUES($1,$2,$3,NULL,$4)", [
    -1,
    10,
    "Name",
    now,
  ]);
  await db.query("INSERT INTO sticker_state VALUES($1,$2,$3,$4)", [
    -1,
    10,
    "{}",
    now,
  ]);
  await db.query("INSERT INTO album_actions VALUES($1,$2,$3,$4,$5)", [
    -1,
    10,
    "album",
    "{}",
    now,
  ]);
  await db.query("INSERT INTO chains VALUES($1,$2,$3,$4,2,false)", [
    -1,
    1,
    now,
    "[10,11]",
  ]);
  const counts = await forget(db, -1, 10, now);
  expect(counts.texts).toBe(2);
  for (const table of [
    "users",
    "stats",
    "stats_weekly",
    "score_events",
    "sticker_state",
    "album_actions",
    "chains",
  ])
    expect(
      (await db.query(`SELECT * FROM ${table} WHERE chat_id=$1`, [-1])).rows,
    ).toHaveLength(0);
  expect(
    (
      await db.query(
        "SELECT raw_text,normalized_text FROM messages WHERE chat_id=$1",
        [-1],
      )
    ).rows.every((r) => r.raw_text === null && r.normalized_text === null),
  ).toBe(true);
  expect((await run(4, "forgotten")).strike).toBe(2);
  expect(
    (await db.query("SELECT raw_text FROM messages WHERE chat_id=$1", [-2]))
      .rows[0]?.raw_text,
  ).toBe("other chat");
  expect(
    (
      await db.query(
        "SELECT action FROM actions WHERE chat_id=$1 AND action='forget'",
        [-1],
      )
    ).rows,
  ).toHaveLength(1);
});
it("purges every table after grace and preserves re-added chats", async () => {
  await run(1, "one");
  await run(2, "one");
  await saveChat(db, { id: -1, type: "supergroup" }, rights, now, true);
  await purgeRemoved(db, new Date(+now + 6 * 86400000));
  expect(await stats()).toBeDefined();
  await saveChat(
    db,
    { id: -1, type: "supergroup" },
    rights,
    new Date(+now + 6 * 86400000),
  );
  await purgeRemoved(db, new Date(+now + 8 * 86400000));
  expect(await stats()).toBeDefined();
  await saveChat(db, { id: -1, type: "supergroup" }, rights, now, true);
  await purgeRemoved(db, new Date(+now + 8 * 86400000));
  for (const table of [
    "chats",
    "messages",
    "fingerprints",
    "strikes",
    "actions",
    "stats",
    "score_events",
    "stats_weekly",
    "users",
    "sticker_state",
    "album_actions",
    "chains",
    "managed_chats",
  ])
    expect(
      (await db.query(`SELECT * FROM ${table} WHERE chat_id=$1`, [-1])).rows,
    ).toHaveLength(0);
});
it("retention deletes each expired category in bounded batches without touching other chats", async () => {
  const old = new Date(+now - 200 * 86400000);
  for (const chat of [-1, -2]) {
    await run(1, "old original", 10, old, classic, false, chat);
    await run(2, "old original", 10, old, classic, false, chat);
    await db.query("INSERT INTO sticker_state VALUES($1,10,$2,$3)", [
      chat,
      "{}",
      old,
    ]);
    await db.query("INSERT INTO album_actions VALUES($1,10,$2,$3,$4)", [
      chat,
      "album",
      "{}",
      old,
    ]);
    await db.query("INSERT INTO chains VALUES($1,1,$2,$3,2,false)", [
      chat,
      old,
      "[10,11]",
    ]);
  }
  await db.query(
    `INSERT INTO messages(chat_id,message_id,user_id,created_at,raw_text) SELECT $1,n,10,$2,'old' FROM generate_series(100,700) n`,
    [-1, old],
  );
  await retainChat(db, -1, now);
  for (const table of [
    "messages",
    "fingerprints",
    "actions",
    "stats_weekly",
    "sticker_state",
    "album_actions",
    "chains",
  ]) {
    expect(
      (await db.query(`SELECT * FROM ${table} WHERE chat_id=$1`, [-1])).rows,
    ).toHaveLength(0);
    expect(
      (await db.query(`SELECT * FROM ${table} WHERE chat_id=$1`, [-2])).rows
        .length,
    ).toBeGreaterThan(0);
  }
});
it("health requires fresh activity and a working database", async () => {
  let time = now;
  const health = new Health(() => time);
  expect(await health.status(db)).toBe(503);
  health.mark();
  expect(await health.status(db)).toBe(200);
  time = new Date(+now + 120000);
  expect(await health.status(db)).toBe(503);
  health.mark();
  expect(
    await health.status({
      ...db,
      query: async () => {
        throw Error("offline");
      },
    }),
  ).toBe(503);
});
it("alerts limit concurrency and report suppressed errors without leaking content", async () => {
  let time = now;
  const send = vi.fn(async (text: string) => {
    return text.length;
  });
  const alerts = new Alerts(() => time, send);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      alerts.report(Error("secret message or token")),
    ),
  );
  expect(send).toHaveBeenCalledTimes(1);
  time = new Date(+now + 60000);
  await alerts.report(Error("secret"));
  expect(send.mock.calls[1]?.[0]).toContain("suppressed since last alert: 3");
  expect(send.mock.calls.flat().join("")).not.toContain("secret");
});

it("serves the HTTP health endpoint and rejects other routes", async () => {
  const health = new Health(() => now);
  const server = health.listen(db, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(url + "/healthz")).status).toBe(503);
    health.mark();
    expect((await fetch(url + "/healthz")).status).toBe(200);
    expect((await fetch(url + "/unknown")).status).toBe(404);
    expect((await fetch(url + "/healthz", { method: "POST" })).status).toBe(
      404,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

it("backfills streaks and scores from legacy messages while excluding no-strike repeats", async () => {
  const { readFile } = await import("node:fs/promises");
  const legacy = pgliteDb();
  try {
    for (const name of [
      "001_init.sql",
      "002_wider_detection.sql",
      "003_settings_menu.sql",
    ]) {
      const sql = await readFile(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      );
      for (const statement of sql.split(";").filter((s) => s.trim()))
        await legacy.query(statement);
    }
    await saveChat(legacy, { id: -1, type: "supergroup" }, rights, now);
    await legacy.query(
      `INSERT INTO messages(chat_id,message_id,user_id,created_at,classification) VALUES(-1,1,10,$1,'original'),(-1,2,10,$1,'original'),(-1,3,10,$1,'repeat'),(-1,4,10,$1,'original'),(-1,5,10,$1,'repeat')`,
      [now],
    );
    await legacy.query("INSERT INTO stats VALUES(-1,10,3,2)");
    await legacy.query(
      `INSERT INTO actions(chat_id,user_id,message_id,action,rule,detail,created_at) VALUES(-1,10,3,'warn','exact_text','{"strike":1}',$1),(-1,10,5,'delete_nostrike','chain','{}',$1)`,
      [now],
    );
    const sql = await readFile(
      new URL("../migrations/004_scores_privacy.sql", import.meta.url),
      "utf8",
    );
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await legacy.query(statement);
    expect(
      (
        await legacy.query(
          "SELECT originals,repeats,streak,best_streak FROM stats WHERE chat_id=$1",
          [-1],
        )
      ).rows,
    ).toEqual([{ originals: 3, repeats: 1, streak: 1, best_streak: 2 }]);
  } finally {
    await legacy.close();
  }
});

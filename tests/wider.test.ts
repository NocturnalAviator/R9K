import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { pgliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { saveChat } from "../src/db/chats.js";
import {
  processMessage,
  type MessageInput,
} from "../src/enforce/process-message.js";
import { parseSettings } from "../src/settings/schema.js";
import { canonicalizeUrl } from "../src/detect/links.js";
import { stepSticker } from "../src/detect/stickers.js";
const db = pgliteDb();
const now = new Date("2026-01-01");
let id = 0;
const settings = parseSettings({ chainMode: "off" });
const input = (extra: Partial<MessageInput> = {}): MessageInput => ({
  chatId: -1,
  userId: 1,
  messageId: ++id,
  text: "",
  settings,
  isEdit: false,
  userIsAdmin: false,
  canMute: true,
  ...extra,
});
const run = (extra: Partial<MessageInput> = {}, time = now) =>
  processMessage(db, input(extra), time);
beforeAll(() => migrate(db));
afterAll(() => db.close());
beforeEach(async () => {
  id = 0;
  for (const chatId of [-1, -2]) {
    await db.query("DELETE FROM chats WHERE chat_id=$1", [chatId]);
    await saveChat(
      db,
      { id: chatId, type: "supergroup" },
      { admin: true, deleteMessages: true, restrictMembers: true },
      now,
    );
  }
});
it.each([
  ["HTTP://WWW.Example.COM.:80/a/#frag", "example.com/a"],
  ["https://example.com:443/", "example.com"],
  ["example.com/a/", "example.com/a"],
  ["https://example.com/?z=3&a=2&a=1", "example.com?a=1&a=2&z=3"],
  [
    "https://example.com/?utm_source=x&utm_x=x&fbclid=x&gclid=x&igshid=x&si=x&ref=x&ref_src=x&mc_cid=x&mc_eid=x&yclid=x&msclkid=x&keep=y",
    "example.com?keep=y",
  ],
  ["https://youtu.be/ABC?t=5", "youtube.com/watch?v=ABC"],
  ["https://youtube.com/shorts/ABC?feature=share", "youtube.com/watch?v=ABC"],
  ["https://m.youtube.com/watch?v=ABC&t=5", "youtube.com/watch?v=ABC"],
  ["https://mobile.twitter.com/a", "x.com/a"],
  ["https://twitter.com/a", "x.com/a"],
  ["https://x.com/a", "x.com/a"],
  ["https://m.example.com/a", "example.com/a"],
  ["https://mobile.example.com/a", "example.com/a"],
  ["https://old.reddit.com/r/a", "reddit.com/r/a"],
])("canonicalizes %s", (url, expected) =>
  expect(canonicalizeUrl(url)).toBe(expected),
);
it.each([
  ["example.com/a", "example.com/b"],
  ["example.com/?a=1", "example.com/?a=2"],
  ["youtu.be/A", "youtu.be/B"],
  ["example.com:8443/a", "example.com/a"],
])("keeps distinct %s and %s", (a, b) =>
  expect(canonicalizeUrl(a)).not.toBe(canonicalizeUrl(b)),
);
it("rejects malformed and non-web links", () => {
  expect(canonicalizeUrl("https://")).toBeNull();
  expect(canonicalizeUrl("ftp://example.com")).toBeNull();
});
it.each(["forward", "media"] as const)(
  "detects %s, scopes by chat, excludes self and respects settings",
  async (kind) => {
    const data =
      kind === "forward"
        ? { forwardOrigin: { type: "channel", chatId: -99, messageId: 5 } }
        : { mediaId: "photo-1", kind: "photo" };
    expect((await run(data)).action).toBe("none");
    expect((await run({ ...data, messageId: 1, isEdit: true })).action).toBe(
      "none",
    );
    expect((await run({ ...data, chatId: -2 })).action).toBe("none");
    expect(
      (
        await run({
          ...data,
          settings: { ...settings, detectForwards: false, detectMedia: false },
        })
      ).action,
    ).toBe("none");
    expect((await run(data)).rule).toBe(kind);
    expect((await run(data, new Date(+now + 86400001))).action).toBe("none");
  },
);
it("ignores unstable forwards and distinguishes origin types and ids", async () => {
  for (const type of ["user", "hidden_user"]) {
    await run({ forwardOrigin: { type } });
    expect((await run({ forwardOrigin: { type } })).action).toBe("none");
  }
  await run({ forwardOrigin: { type: "chat", chatId: -3, messageId: 1 } });
  expect(
    (await run({ forwardOrigin: { type: "chat", chatId: -3, messageId: 1 } }))
      .rule,
  ).toBe("forward");
  expect(
    (
      await run({
        forwardOrigin: { type: "channel", chatId: -3, messageId: 1 },
      })
    ).action,
  ).toBe("none");
  expect(
    (await run({ forwardOrigin: { type: "chat", chatId: -3, messageId: 2 } }))
      .action,
  ).toBe("none");
});
it("uses forward, media, exact text, link, near text precedence", async () => {
  const data = {
    text: "a sufficiently long original sentence about cats",
    mediaId: "m",
    forwardOrigin: { type: "channel", chatId: -3, messageId: 1 },
  };
  await run(data);
  expect((await run(data)).rule).toBe("forward");
  expect((await run({ ...data, forwardOrigin: undefined })).rule).toBe("media");
  expect((await run({ text: data.text })).rule).toBe("exact_text");
});
const linked = (text: string, url: string): Partial<MessageInput> => ({
  text: `${text} ${url}`,
  entities: [{ type: "url", offset: text.length + 1, length: url.length }],
  settings: { ...settings, detectLinks: true },
});
it("matches canonical links with different text; distinct links do not collide on residual text", async () => {
  await run(linked("look", "https://example.com/a"));
  expect((await run(linked("look", "https://example.com/b"))).action).toBe(
    "none",
  );
  expect(
    (await run(linked("different", "http://www.example.com/a/?utm_source=x")))
      .rule,
  ).toBe("link");
  expect(
    (await run({ ...linked("different", "https://example.com/a"), settings }))
      .action,
  ).toBe("none");
});
it("stores distinct links, strips UTF-16 text_link labels, and skips link-only text fingerprints", async () => {
  const data = {
    text: "😀 click and https://example.com/b",
    entities: [
      { type: "text_link", offset: 3, length: 5, url: "https://example.com/a" },
      { type: "url", offset: 13, length: 21 },
    ],
    settings: { ...settings, detectLinks: true },
  };
  await run(data);
  expect((await run(linked("new", "https://example.com/a"))).rule).toBe("link");
  expect(
    (
      await db.query(
        "SELECT hash FROM fingerprints WHERE chat_id=$1 AND message_id=1 AND kind='link'",
        [-1],
      )
    ).rows,
  ).toHaveLength(2);
  await run({
    text: "https://example.org/",
    entities: [{ type: "url", offset: 0, length: 20 }],
    settings: { ...settings, detectLinks: true },
  });
  expect(
    (
      await db.query(
        "SELECT hash FROM fingerprints WHERE chat_id=$1 AND message_id=$2 AND kind='text'",
        [-1, id],
      )
    ).rows,
  ).toHaveLength(0);
});
it("uses SET LOCAL and trigram operator with threshold, length, window and chat isolation", async () => {
  const text = "the quick brown fox jumps over the lazy dog";
  const changed = "the quick brown fox jumps over this lazy dog";
  const fuzzy = { ...settings, detectNearText: true, nearTextThreshold: 0.8 };
  await run({ text });
  const hit = await run({ text: changed, settings: fuzzy });
  expect(hit.rule).toBe("near_text");
  expect(hit.similarity).toBeGreaterThanOrEqual(0.8);
  expect(
    (
      await run({
        text: changed,
        settings: { ...fuzzy, nearTextThreshold: 0.95 },
      })
    ).action,
  ).toBe("none");
  expect(
    (await run({ text: changed, chatId: -2, settings: fuzzy })).action,
  ).toBe("none");
  expect(
    (
      await run({
        text: "the quick brown fox jumped over the lazy dog",
        settings: { ...fuzzy, minFuzzyLength: 100 },
      })
    ).action,
  ).toBe("none");
  expect(
    (
      await run(
        { text: "the quick brown fox jumped over a lazy dog", settings: fuzzy },
        new Date(+now + 86400001),
      )
    ).action,
  ).toBe("none");
});
it("applies only one album penalty and notice, and deletes later items after mute", async () => {
  await run({ mediaId: "a" });
  await run({ mediaId: "b" });
  const album = {
    mediaGroupId: "album",
    settings: { ...settings, warnStrikes: 0, deleteOnlyStrikes: 0 },
  };
  expect((await run({ ...album, mediaId: "a" })).action).toBe("mute");
  expect(await run({ ...album, mediaId: "b" })).toMatchObject({
    action: "delete_nostrike",
    silent: true,
  });
  expect(
    (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-1])).rows,
  ).toEqual([{ level: 1 }]);
});
it("collapse requires multiple users and a timely chain; repeats never become originals", async () => {
  const s = { ...settings, chainMode: "collapse" as const };
  await run({ text: "hello", settings: s });
  expect((await run({ text: "hello", settings: s })).strike).toBe(1);
  expect(await run({ text: "hello", userId: 2, settings: s })).toMatchObject({
    action: "delete_nostrike",
    rule: "chain",
    silent: true,
  });
  expect(
    (
      await run(
        { text: "hello", userId: 3, settings: s },
        new Date(+now + 61000),
      )
    ).strike,
  ).toBe(1);
  expect(
    (
      await db.query(
        "SELECT message_id FROM fingerprints WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toHaveLength(1);
});
it("tolerates the configured total length then enforces and stops tolerating returning users", async () => {
  const s = { ...settings, chainMode: "tolerate" as const, chainMaxLength: 3 };
  await run({ text: "hello", settings: s });
  for (const userId of [2, 3])
    expect((await run({ text: "hello", userId, settings: s })).action).toBe(
      "none",
    );
  expect((await run({ text: "hello", userId: 4, settings: s })).strike).toBe(1);
  await run({ text: "other", settings: s });
  expect((await run({ text: "other", userId: 2, settings: s })).action).toBe(
    "none",
  );
  expect((await run({ text: "other", userId: 2, settings: s })).strike).toBe(1);
  expect((await run({ text: "other", userId: 3, settings: s })).strike).toBe(1);
});
it.each([
  ["min_length", "a", { minLength: 3 }],
  ["emoji_only", "😀😀", { emojiOnly: true }],
  ["all_caps", "HELLO WORLD", { allCaps: true }],
  ["one_word", "yes", { oneWord: true }],
])("deletes %s with no strike or storage", async (rule, text, filter) => {
  const s = { ...settings, lowEffort: { ...settings.lowEffort, ...filter } };
  expect(await run({ text, isReply: true, settings: s })).toMatchObject({
    action: "delete_nostrike",
    rule,
  });
  expect(
    (await db.query("SELECT message_id FROM messages WHERE chat_id=$1", [-1]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-1])).rows,
  ).toHaveLength(0);
  expect(
    (await run({ text, mediaId: "photo", kind: "photo", settings: s })).action,
  ).toBe("none");
});
it("low effort misses short caps, mixed case, emoji with words and non-reply words", async () => {
  const s = parseSettings({
    lowEffort: { allCaps: true, emojiOnly: true, oneWord: true },
  });
  for (const text of ["HI", "Hello WORLD", "😀 wow", "yes"])
    expect((await run({ text, settings: s })).action).toBe("none");
});
it("pure bucket maths refill continuously and prune cooldown timestamps", () => {
  const s = parseSettings({
    stickers: {
      mode: "custom",
      budget: 1,
      windowSeconds: 10,
      maxConsecutive: 20,
      cooldownSeconds: 2,
    },
  }).stickers;
  const first = stepSticker(undefined, "a", now, s);
  expect(first.rule).toBeUndefined();
  const half = stepSticker(first.state, "b", new Date(+now + 5000), s);
  expect(half.rule).toBe("sticker_budget");
  expect(half.state.recent).not.toHaveProperty("a");
  expect(
    stepSticker(first.state, "b", new Date(+now + 10000), s).rule,
  ).toBeUndefined();
});
it.each([
  [
    "sticker_budget",
    { budget: 1, maxConsecutive: 10, cooldownSeconds: 0 },
    "b",
  ],
  ["sticker_run", { budget: 10, maxConsecutive: 1, cooldownSeconds: 0 }, "b"],
  [
    "sticker_cooldown",
    { budget: 10, maxConsecutive: 10, cooldownSeconds: 60 },
    "a",
  ],
])(
  "enforces %s independently without strikes",
  async (rule, numbers, second) => {
    const s = parseSettings({
      stickers: { mode: "custom", windowSeconds: 60, ...numbers },
    });
    await run({ stickerId: "a", settings: s });
    expect(await run({ stickerId: second, settings: s })).toMatchObject({
      action: "delete_nostrike",
      rule,
    });
    expect(
      (await db.query("SELECT level FROM strikes WHERE chat_id=$1", [-1])).rows,
    ).toHaveLength(0);
  },
);
it("resets sticker runs, exempts admins, and permits off mode", async () => {
  const s = parseSettings({
    stickers: {
      mode: "custom",
      budget: 10,
      maxConsecutive: 1,
      cooldownSeconds: 0,
    },
  });
  await run({ stickerId: "a", settings: s });
  await run({ text: "hello", settings: s });
  expect((await run({ stickerId: "b", settings: s })).action).toBe("none");
  expect(
    (await run({ stickerId: "b", settings: s, userIsAdmin: true })).action,
  ).toBe("none");
  const off = parseSettings({ stickers: { mode: "off" } });
  for (let n = 0; n < 12; n++)
    expect((await run({ stickerId: "b", settings: off })).action).toBe("none");
});
it("edits update stats only on classification changes", async () => {
  await run({ text: "first", messageId: 1 });
  await run({ text: "second", messageId: 2 });
  await run({ text: "second!", messageId: 2, isEdit: true });
  expect(
    (
      await db.query(
        "SELECT originals,repeats FROM stats WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toEqual([{ originals: 2, repeats: 0 }]);
  await run({ text: "first", messageId: 2, isEdit: true });
  await run({ text: "first!", messageId: 2, isEdit: true });
  expect(
    (
      await db.query(
        "SELECT originals,repeats FROM stats WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toEqual([{ originals: 1, repeats: 1 }]);
  await run({ text: "third", messageId: 2, isEdit: true });
  expect(
    (
      await db.query(
        "SELECT originals,repeats FROM stats WHERE chat_id=$1",
        [-1],
      )
    ).rows,
  ).toEqual([{ originals: 2, repeats: 0 }]);
});

it("can use the trigram GIN index for the engine predicate", async () => {
  await run({ text: "a lengthy original example for fuzzy matching" });
  // A realistic corpus makes the selective trigram index cheaper than the chat key.
  await db.query(
    `INSERT INTO messages(chat_id,message_id,user_id,raw_text,normalized_text,created_at,classification)
    SELECT $1,n,1,md5(n::text),md5(n::text),$2,'original' FROM generate_series(10,5010) n`,
    [-1, now],
  );
  await db.query(
    `INSERT INTO fingerprints(chat_id,message_id,user_id,kind,hash,created_at)
    SELECT chat_id,message_id,user_id,'text',normalized_text,created_at FROM messages WHERE chat_id=$1 AND message_id>=10`,
    [-1],
  );
  await db.query("VACUUM ANALYZE messages");
  await db.query("ANALYZE fingerprints");
  const plan = await db.tx(async (tx) => {
    await tx.query("SET LOCAL enable_seqscan = off");
    await tx.query("SET LOCAL pg_trgm.similarity_threshold = 0.8");
    return tx.query(
      `EXPLAIN SELECT m.message_id, similarity(m.normalized_text,$2) AS similarity
      FROM messages m WHERE m.chat_id=$1 AND m.message_id<>$3 AND m.normalized_text % $2
      AND ($4::timestamptz IS NULL OR m.created_at>$4)
      AND EXISTS (SELECT 1 FROM fingerprints f WHERE f.chat_id=$1 AND f.message_id=m.message_id AND f.kind='text')
      ORDER BY similarity DESC LIMIT 1`,
      [-1, "a lengthy original example for fuzzy matching", 2, null],
    );
  });
  // An indexable predicate is required; production chooses its plan using table statistics.
  expect(JSON.stringify(plan.rows)).toContain("messages_normalized_trgm");
});
it("near-text disabled, shorter candidates and unrelated texts stay original", async () => {
  await run({ text: "the quick brown fox jumps over the lazy dog" });
  expect(
    (await run({ text: "the quick brown fox jumps over this lazy dog" }))
      .action,
  ).toBe("none");
  await run({ text: "hello friends" });
  expect(
    (
      await run({
        text: "hello friend",
        settings: { ...settings, detectNearText: true },
      })
    ).action,
  ).toBe("none");
  expect(
    (
      await run({
        text: "completely unrelated material about astronomy",
        settings: { ...settings, detectNearText: true },
      })
    ).action,
  ).toBe("none");
});
it("exact-text precedes links, links precede near-text and only originals supply fuzzy candidates", async () => {
  const s = { ...settings, detectLinks: true, detectNearText: true };
  const first = {
    ...linked(
      "a lengthy discussion of this interesting topic",
      "https://example.com/a",
    ),
    settings: s,
  };
  await run(first);
  expect((await run(first)).rule).toBe("exact_text");
  expect(
    (
      await run({
        ...linked(
          "a lengthy discussion of that interesting topic",
          "https://example.com/a",
        ),
        settings: s,
      })
    ).rule,
  ).toBe("link");
  // The link repeat's text cannot seed fuzzy matching.
  expect(
    (
      await run({
        text: "a lengthy discussion of that interesting topic https://example.com/a",
        settings: { ...s, detectLinks: false, nearTextThreshold: 0.95 },
      })
    ).action,
  ).toBe("none");
});
it("warned albums do not produce another reaction or strike, and other albums remain independent", async () => {
  await run({ mediaId: "a" });
  await run({ mediaId: "b" });
  expect((await run({ mediaId: "a", mediaGroupId: "first" })).strike).toBe(1);
  expect(await run({ mediaId: "b", mediaGroupId: "first" })).toMatchObject({
    action: "none",
    silent: true,
  });
  expect((await run({ mediaId: "b", mediaGroupId: "second" })).strike).toBe(2);
});
it("sticker state is isolated by user/chat and refills in the database", async () => {
  const s = parseSettings({
    stickers: {
      mode: "custom",
      budget: 1,
      windowSeconds: 10,
      maxConsecutive: 20,
      cooldownSeconds: 0,
    },
  });
  await run({ stickerId: "a", settings: s });
  expect((await run({ stickerId: "a", userId: 2, settings: s })).action).toBe(
    "none",
  );
  expect((await run({ stickerId: "a", chatId: -2, settings: s })).action).toBe(
    "none",
  );
  expect(
    (await run({ stickerId: "b", settings: s }, new Date(+now + 5000))).rule,
  ).toBe("sticker_budget");
  expect(
    (await run({ stickerId: "b", settings: s }, new Date(+now + 10000))).action,
  ).toBe("none");
});
it("fills sticker modes and recovers invalid nested settings", () => {
  expect(
    parseSettings({ stickers: { mode: "strict", budget: 99 } }).stickers,
  ).toMatchObject({ budget: 3, maxConsecutive: 2, cooldownSeconds: 300 });
  expect(parseSettings({ stickers: null, lowEffort: null }).stickers.mode).toBe(
    "normal",
  );
  expect(
    parseSettings({
      stickers: { mode: "custom", budget: -1 },
      lowEffort: { minLength: -1, allCaps: true },
    }),
  ).toMatchObject({
    stickers: { budget: 5 },
    lowEffort: { minLength: 0, allCaps: true },
  });
});

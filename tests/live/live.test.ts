// Tests against real Telegram and the running bot, driven by logged-in user
// accounts (see docs in README: "Live tests"). They post only in the chat
// named by LIVE_CHAT_ID. Run with: npm run test:live
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, type TelegramClient } from "telegram";
import { botId, connect, hasSession, liveChatId } from "./client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unique = (label: string) =>
  `live test ${label} ${randomBytes(6).toString("hex")}`;

interface Stats {
  originals: number;
  repeats: number;
  strike: number;
}

class Account {
  constructor(
    readonly client: TelegramClient,
    readonly chat: Api.TypeInputPeer,
  ) {}

  static async open(role: "member" | "admin"): Promise<Account> {
    const client = await connect(role);
    // Listing dialogs teaches the client the group's access hash.
    await client.getDialogs({ limit: 100 });
    return new Account(client, await client.getInputEntity(liveChatId()));
  }

  async say(text: string): Promise<number> {
    return (await this.client.sendMessage(this.chat, { message: text })).id;
  }

  async exists(id: number): Promise<boolean> {
    const [message] = await this.client.getMessages(this.chat, { ids: [id] });
    return message !== undefined && !(message instanceof Api.MessageEmpty);
  }

  /** Messages from the bot that this account can see, newer than `afterId`. */
  async botMessages(afterId: number): Promise<Api.Message[]> {
    const messages = await this.client.getMessages(this.chat, {
      minId: afterId,
      limit: 50,
    });
    return messages.filter((m) => String(m.senderId) === botId());
  }

  /** Waits for the bot's visible reply to one of this account's messages. */
  async reply(toId: number, timeoutMs = 10000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await this.botMessages(toId)).find(
        (m) => m.replyTo?.replyToMsgId === toId,
      );
      if (found) return found.message;
      if (Date.now() > deadline)
        throw new Error(
          "The bot did not answer. Is it running and in the test group?",
        );
      await sleep(500);
    }
  }

  /** A command typed as plain text gets an ordinary reply the script can read. */
  async stats(): Promise<Stats> {
    const text = await this.reply(await this.say("/me"));
    const match =
      /Originals: (\d+); repeats: (\d+);.*strike level: (\d+(?:\.\d+)?)/.exec(
        text,
      );
    if (!match) throw new Error(`Unexpected /me answer: ${text}`);
    return {
      originals: Number(match[1]),
      repeats: Number(match[2]),
      strike: Number(match[3]),
    };
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }
}

const describeIf = (condition: boolean) =>
  condition ? describe : describe.skip;

describeIf(hasSession("member"))("ordinary member on real Telegram", () => {
  let member: Account;
  beforeAll(async () => {
    member = await Account.open("member");
  });
  afterAll(async () => {
    await member?.close();
  });

  it("counts an original, then punishes its repeat", async () => {
    const before = await member.stats();
    const text = unique("original");

    const first = await member.say(text);
    await sleep(2500);
    expect(await member.exists(first), "original was left alone").toBe(true);
    const afterOriginal = await member.stats();
    expect(afterOriginal.originals).toBe(before.originals + 1);
    expect(afterOriginal.repeats).toBe(before.repeats);

    await member.say(text);
    await sleep(2500);
    const afterRepeat = await member.stats();
    expect(afterRepeat.repeats).toBe(before.repeats + 1);
    expect(afterRepeat.originals).toBe(afterOriginal.originals);
    expect(afterRepeat.strike).toBeGreaterThan(afterOriginal.strike);
    expect(await member.exists(first), "original survives its repeat").toBe(
      true,
    );
  });

  it("shows a non-admin nothing for /settings", async () => {
    const command = await member.say("/settings");
    await sleep(3000);
    expect(await member.botMessages(command)).toHaveLength(0);
  });
});

describeIf(hasSession("member") && hasSession("admin"))(
  "admin settings on real Telegram",
  () => {
    let member: Account;
    let admin: Account;
    beforeAll(async () => {
      member = await Account.open("member");
      admin = await Account.open("admin");
    });
    afterAll(async () => {
      await member?.close();
      await admin?.close();
    });

    it("opens /settings without the rest of the group seeing anything", async () => {
      const marker = await member.say(unique("marker"));
      const command = await admin.say("/settings");
      await sleep(3000);
      expect(
        await member.exists(command),
        "the typed command is removed from the group",
      ).toBe(false);
      expect(
        await member.botMessages(marker),
        "the member sees no menu and no fallback button",
      ).toHaveLength(0);
    });
  },
);

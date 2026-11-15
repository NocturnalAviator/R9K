import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

/** Scripted accounts: an ordinary group member and, optionally, a group admin. */
export type Role = "member" | "admin";
export const roles: readonly Role[] = ["member", "admin"];

// Saved logins give full access to the account, so they stay in the
// gitignored data directory with owner-only permissions.
const dir = join(process.cwd(), ".data", "live");
const sessionPath = (role: Role) => join(dir, `${role}.session`);

export const hasSession = (role: Role): boolean =>
  existsSync(sessionPath(role));

export function saveSession(role: Role, client: TelegramClient): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = sessionPath(role);
  writeFileSync(path, String(client.session.save()), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

export function createClient(role: Role): TelegramClient {
  const saved = hasSession(role)
    ? readFileSync(sessionPath(role), "utf8").trim()
    : "";
  const client = new TelegramClient(
    new StringSession(saved),
    Number(required("TG_API_ID")),
    required("TG_API_HASH"),
    { connectionRetries: 3 },
  );
  client.setLogLevel("error" as Parameters<typeof client.setLogLevel>[0]);
  return client;
}

/** Connects a previously logged-in account; fails if the login has lapsed. */
export async function connect(role: Role): Promise<TelegramClient> {
  const client = createClient(role);
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.destroy();
    throw new Error(
      `The saved ${role} login is no longer valid. Run: npm run live:login -- ${role}`,
    );
  }
  return client;
}

export const liveChatId = (): string => required("LIVE_CHAT_ID");
/** The bot's user id is the part of its token before the colon. */
export const botId = (): string => required("BOT_TOKEN").split(":")[0]!;

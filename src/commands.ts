import type { Api } from "grammy";
import type { BotCommand } from "grammy/types";

// The lists Telegram clients show when a user types "/". Commands marked
// ephemeral are sent so that only the sender and the bot see them.
const hidden = (command: string, description: string): BotCommand => ({
  command,
  description,
  is_ephemeral: true,
});
const member: BotCommand[] = [
  hidden("me", "Your originality score and strikes"),
  { command: "top", description: "This week's most original posters" },
  hidden("why", "Why the bot acted on your last message"),
  hidden("forgetme", "Erase your stored text in this chat"),
  hidden("privacy", "What the bot stores"),
  hidden("help", "What this bot does"),
];
const admin: BotCommand[] = [
  hidden("settings", "Configure the bot for this chat"),
  hidden("allow", "Allow a phrase to be repeated: /allow phrase"),
  hidden("status", "Check the bot's rights and current rules"),
  ...member,
];
const direct: BotCommand[] = [
  { command: "settings", description: "Configure a chat you administer" },
  { command: "forgetme", description: "Erase your stored text everywhere" },
  { command: "privacy", description: "What the bot stores" },
  { command: "help", description: "What this bot does" },
];

export async function registerCommands(api: Api): Promise<void> {
  await api.setMyCommands(direct, { scope: { type: "all_private_chats" } });
  await api.setMyCommands(member, { scope: { type: "all_group_chats" } });
  await api.setMyCommands(admin, {
    scope: { type: "all_chat_administrators" },
  });
}

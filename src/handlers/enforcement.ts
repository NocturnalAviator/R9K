import type { Context } from "grammy";
import type { Logger } from "pino";
import type { Verdict } from "../enforce/strikes.js";
import type { Settings } from "../settings/schema.js";
import { errorSummary } from "../errors.js";
export function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  const parts: string[] = [];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    seconds -= n * size;
    if (n) parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0 seconds";
}
export async function sendNotice(
  ctx: Context,
  userId: number,
  text: string,
): Promise<void> {
  if (!ctx.chat) return;
  try {
    // Bot API 10.2 ephemeral message: shown in the group to this user only.
    await ctx.api.sendMessage(ctx.chat.id, text, {
      ephemeral_message_parameters: { receiver_user_id: userId },
    });
    return;
  } catch {
    /* Private fallback below. */
  }
  try {
    await ctx.api.sendMessage(userId, text);
  } catch {
    /* Never expose a notice to the group. */
  }
}
export async function applyVerdict(
  ctx: Context,
  userId: number,
  messageId: number,
  v: Verdict,
  s: Settings,
  now: Date,
  logger: Logger,
): Promise<void> {
  if (v.action === "none" || !ctx.chat) return;
  const chatId = ctx.chat.id;
  async function guard(
    action: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (e) {
      logger.warn(
        {
          chatId,
          userId,
          messageId,
          action,
          rule: v.rule,
          err: errorSummary(e),
        },
        "Telegram action failed",
      );
    }
  }
  if (v.action === "warn")
    await guard("reaction", () =>
      ctx.api.setMessageReaction(chatId, messageId, [
        { type: "emoji", emoji: "👀" },
      ]),
    );
  else await guard("delete", () => ctx.api.deleteMessage(chatId, messageId));
  if (v.action === "mute")
    await guard("mute", () =>
      ctx.api.restrictChatMember(
        chatId,
        userId,
        {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false,
          can_manage_topics: false,
        },
        {
          use_independent_chat_permissions: true,
          until_date:
            Math.ceil(now.getTime() / 1000) +
            Math.max(40, Math.ceil(v.muteSeconds ?? 0)),
        },
      ),
    );
  const ending =
    v.action === "warn"
      ? `Warning ${v.strike} of ${s.warnStrikes}.`
      : v.action === "delete"
        ? "Message removed."
        : `Muted for ${formatDuration(Math.max(40, Math.ceil(v.muteSeconds ?? 0)))}.`;
  await sendNotice(
    ctx,
    userId,
    `Repeat: this was already posted here on ${v.matchedAt?.toISOString().slice(0, 10) ?? "an earlier date"}. ${ending}`,
  );
}

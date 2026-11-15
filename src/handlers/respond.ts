import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

/** True when the incoming command was sent as an ephemeral command (Bot API 10.2). */
export const isEphemeral = (ctx: Context): boolean =>
  ctx.msg?.ephemeral_message_id !== undefined;

/** Sends a group message that only `userId` (and the bot) can see. */
export function sendEphemeral(
  ctx: Context,
  userId: number,
  text: string,
  reply_markup?: InlineKeyboardMarkup,
) {
  return ctx.api.sendMessage(ctx.chat!.id, text, {
    reply_markup,
    ephemeral_message_parameters: { receiver_user_id: userId },
  });
}

/**
 * Answers a command the way it was asked: privately when the command was
 * ephemeral (a reply to an ephemeral message must itself be ephemeral, and
 * its message_id is 0), as a normal reply otherwise.
 */
export async function respond(ctx: Context, text: string): Promise<void> {
  if (isEphemeral(ctx) && ctx.from) await sendEphemeral(ctx, ctx.from.id, text);
  else
    await ctx.reply(
      text,
      ctx.msg ? { reply_parameters: { message_id: ctx.msg.message_id } } : {},
    );
}

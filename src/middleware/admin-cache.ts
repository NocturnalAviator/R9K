import type { Context } from "grammy";
export class AdminCache {
  private entries = new Map<number, { expires: number; ids: Set<number> }>();
  constructor(private clock: () => Date) {}
  invalidate(chatId: number): void {
    this.entries.delete(chatId);
  }
  async isAdmin(ctx: Context, userId: number): Promise<boolean> {
    if (!ctx.chat) return false;
    const chatId = ctx.chat.id;
    let entry = this.entries.get(chatId);
    if (!entry || entry.expires <= this.clock().getTime()) {
      const members = await ctx.api.getChatAdministrators(chatId);
      entry = {
        expires: this.clock().getTime() + 600000,
        ids: new Set(members.map((m) => m.user.id)),
      };
      this.entries.set(chatId, entry);
    }
    return entry.ids.has(userId);
  }
}

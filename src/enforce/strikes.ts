import type { Settings } from "../settings/schema.js";
import type { Db } from "../db/index.js";
export interface Verdict {
  action: "none" | "warn" | "delete" | "mute" | "delete_nostrike";
  silent?: boolean;
  similarity?: number;
  muteSeconds?: number;
  strike?: number;
  rule?: string;
  matchedMessageId?: number;
  matchedAt?: Date;
}
/** A stored strike level after decay: it halves every `strikeHalfLifeSeconds`. */
export function decayedLevel(
  level: number,
  updated: Date,
  now: Date,
  s: Settings,
): number {
  return (
    level *
    0.5 **
      (Math.max(0, now.getTime() - updated.getTime()) /
        1000 /
        s.strikeHalfLifeSeconds)
  );
}
export function nextStrike(
  level: number,
  updated: Date,
  now: Date,
  s: Settings,
  canMute: boolean,
): Verdict {
  // Rounded, not floored: decay is continuous, so one second after a first
  // strike the level is 0.99998, and flooring it would make every offence
  // "strike 1" forever. A strike stops counting once it has decayed below half.
  const strike = Math.round(decayedLevel(level, updated, now, s)) + 1;
  if (strike <= s.warnStrikes) return { action: "warn", strike };
  if (strike <= s.warnStrikes + s.deleteOnlyStrikes || !canMute)
    return { action: "delete", strike };
  return {
    action: "mute",
    strike,
    muteSeconds: Math.min(
      s.muteCapSeconds,
      s.muteBaseSeconds *
        s.muteMultiplier ** (strike - s.warnStrikes - s.deleteOnlyStrikes - 1),
    ),
  };
}
export async function recordStrike(
  db: Db,
  chatId: number,
  userId: number,
  now: Date,
  s: Settings,
  canMute: boolean,
): Promise<Verdict> {
  const row = (
    await db.query<{ level: number; updated_at: Date }>(
      "SELECT level,updated_at FROM strikes WHERE chat_id=$1 AND user_id=$2",
      [chatId, userId],
    )
  ).rows[0];
  const level = row?.level ?? 0;
  const updated = row?.updated_at ?? now;
  const verdict = nextStrike(level, updated, now, s, canMute);
  await db.query(
    "INSERT INTO strikes(chat_id,user_id,level,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET level=$3,updated_at=$4",
    [chatId, userId, decayedLevel(level, updated, now, s) + 1, now],
  );
  return verdict;
}

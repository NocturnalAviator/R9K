import type { Settings } from "../settings/schema.js";
import type { Db } from "../db/index.js";
export interface Verdict {
  action: "none" | "warn" | "delete" | "mute";
  muteSeconds?: number;
  strike?: number;
  rule?: string;
  matchedMessageId?: number;
  matchedAt?: Date;
}
export function nextStrike(
  level: number,
  updated: Date,
  now: Date,
  s: Settings,
  canMute: boolean,
): Verdict {
  const effective =
    level *
    0.5 **
      (Math.max(0, now.getTime() - updated.getTime()) /
        1000 /
        s.strikeHalfLifeSeconds);
  const strike = Math.floor(effective) + 1;
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
  const verdict = nextStrike(
    row?.level ?? 0,
    row?.updated_at ?? now,
    now,
    s,
    canMute,
  );
  await db.query(
    "INSERT INTO strikes(chat_id,user_id,level,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET level=$3,updated_at=$4",
    [chatId, userId, verdict.strike, now],
  );
  return verdict;
}

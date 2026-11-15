import type { Db } from "../db/index.js";
export function weekStart(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export async function score(
  db: Db,
  chatId: number,
  userId: number,
  messageId: number,
  classification: string | null,
  now: Date,
): Promise<void> {
  const old = (
    await db.query<{ classification: string; created_at: Date }>(
      "SELECT classification,created_at FROM score_events WHERE chat_id=$1 AND message_id=$2",
      [chatId, messageId],
    )
  ).rows[0];
  if ((old?.classification ?? null) === classification) return;
  const date = old?.created_at ?? now;
  const originals =
    Number(classification === "original") -
    Number(old?.classification === "original");
  const repeats =
    Number(classification === "repeat") -
    Number(old?.classification === "repeat");
  if (classification)
    await db.query(
      "INSERT INTO score_events(chat_id,user_id,message_id,created_at,classification) VALUES($1,$2,$3,$4,$5) ON CONFLICT(chat_id,message_id) DO UPDATE SET classification=$5",
      [chatId, userId, messageId, date, classification],
    );
  else
    await db.query(
      "DELETE FROM score_events WHERE chat_id=$1 AND message_id=$2",
      [chatId, messageId],
    );
  for (const weekly of [false, true]) {
    if (
      weekly &&
      new Date(weekStart(date)).getTime() < +now - 26 * 7 * 86400000
    )
      continue;
    await db.query(
      weekly
        ? `INSERT INTO stats_weekly(chat_id,user_id,week_start,originals,repeats) VALUES($1,$2,$5,$3,$4) ON CONFLICT(chat_id,user_id,week_start) DO UPDATE SET originals=stats_weekly.originals+$3,repeats=stats_weekly.repeats+$4`
        : `INSERT INTO stats(chat_id,user_id,originals,repeats) VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET originals=stats.originals+$3,repeats=stats.repeats+$4`,
      weekly
        ? [chatId, userId, originals, repeats, weekStart(date)]
        : [chatId, userId, originals, repeats],
    );
  }
  // New messages normally append to the history: avoid scanning a user's lifetime
  // events on every post. Old edits or out-of-order timestamps rebuild the run.
  if (
    !old &&
    classification &&
    !(
      await db.query(
        "SELECT message_id FROM score_events WHERE chat_id=$1 AND user_id=$2 AND (created_at,message_id)>($3,$4) LIMIT 1",
        [chatId, userId, date, messageId],
      )
    ).rows.length
  ) {
    await db.query(
      "UPDATE stats SET streak=CASE WHEN $3='original' THEN streak+1 ELSE 0 END,best_streak=GREATEST(best_streak,CASE WHEN $3='original' THEN streak+1 ELSE 0 END) WHERE chat_id=$1 AND user_id=$2",
      [chatId, userId, classification],
    );
    return;
  }
  const events = await db.query<{ classification: string }>(
    "SELECT classification FROM score_events WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at,message_id",
    [chatId, userId],
  );
  let streak = 0,
    best = 0;
  for (const e of events.rows) {
    streak = e.classification === "original" ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  await db.query(
    "UPDATE stats SET streak=$3,best_streak=GREATEST(best_streak,$4) WHERE chat_id=$1 AND user_id=$2",
    [chatId, userId, streak, best],
  );
}
export const rate = (o: number, r: number): string =>
  `${o + r ? ((100 * o) / (o + r)).toFixed(1) : "0.0"}%`;
export async function top(
  db: Db,
  chatId: number,
  week: string,
): Promise<string> {
  const rows = await db.query<{
    originals: number;
    repeats: number;
    streak: number;
    first_name: string | null;
    username: string | null;
  }>(
    `SELECT w.originals,w.repeats,COALESCE(s.streak,0) AS streak,u.first_name,u.username FROM stats_weekly w LEFT JOIN stats s ON s.chat_id=w.chat_id AND s.user_id=w.user_id LEFT JOIN users u ON u.chat_id=w.chat_id AND u.user_id=w.user_id WHERE w.chat_id=$1 AND w.week_start=$2 AND w.originals>0 ORDER BY w.originals DESC,w.originals::numeric/NULLIF(w.originals+w.repeats,0) DESC,w.user_id LIMIT 10`,
    [chatId, week],
  );
  return (
    `Top originals — week of ${week}\n` +
    (rows.rows
      .map(
        (r, i) =>
          `${i + 1}. ${(r.first_name || r.username || "Forgotten user")
            .replace(/@/g, "")
            .replace(/[\r\n]/g, " ")
            .slice(
              0,
              100,
            )}: ${r.originals}, ${rate(r.originals, r.repeats)}, streak ${r.streak}`,
      )
      .join("\n") || "No originals yet.")
  );
}
// Claim before sending: restart-safe at-most-once delivery; an ambiguous failure is not retried.
export async function postWeekly(
  db: Db,
  now: Date,
  send: (id: number, text: string) => Promise<unknown>,
): Promise<void> {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 9) return;
  const week = weekStart(new Date(+now - 7 * 86400000));
  const chats = await db.query<{ chat_id: number }>(
    "SELECT chat_id FROM chats",
  );
  for (const { chat_id } of chats.rows) {
    const claim = await db.query(
      `UPDATE chats SET last_posted_week=$2 WHERE chat_id=$1 AND removed_at IS NULL AND settings->'leaderboard'->>'weekly'='true' AND (last_posted_week IS NULL OR last_posted_week<$2::date) RETURNING chat_id`,
      [chat_id, week],
    );
    if (claim.rows.length) await send(chat_id, await top(db, chat_id, week));
  }
}

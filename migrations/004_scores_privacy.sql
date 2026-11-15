ALTER TABLE stats ADD COLUMN streak bigint NOT NULL DEFAULT 0;
ALTER TABLE stats ADD COLUMN best_streak bigint NOT NULL DEFAULT 0;
CREATE TABLE stats_weekly (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, week_start date NOT NULL, originals bigint NOT NULL DEFAULT 0, repeats bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(chat_id,user_id,week_start)
);
CREATE TABLE score_events (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, message_id bigint NOT NULL, created_at timestamptz NOT NULL, classification text NOT NULL,
 PRIMARY KEY(chat_id,message_id)
);
CREATE INDEX score_events_user ON score_events(chat_id,user_id,created_at,message_id);
CREATE TABLE users (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, first_name text NOT NULL, username text, updated_at timestamptz NOT NULL,
 PRIMARY KEY(chat_id,user_id)
);
ALTER TABLE chats ADD COLUMN last_posted_week date;
ALTER TABLE chats ADD COLUMN last_top_at timestamptz;
ALTER TABLE album_actions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sticker_state ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
INSERT INTO score_events SELECT m.chat_id,m.user_id,m.message_id,m.created_at,m.classification FROM messages m WHERE m.classification='original' OR (m.classification='repeat' AND EXISTS (SELECT 1 FROM actions a WHERE a.chat_id=m.chat_id AND a.message_id=m.message_id AND a.detail->>'strike' IS NOT NULL));
INSERT INTO stats_weekly SELECT chat_id,user_id,date_trunc('week',created_at AT TIME ZONE 'UTC')::date,count(*) FILTER(WHERE classification='original'),count(*) FILTER(WHERE classification='repeat') FROM score_events WHERE created_at>=now()-interval '26 weeks' GROUP BY chat_id,user_id,date_trunc('week',created_at AT TIME ZONE 'UTC')::date;
WITH numbered AS (
 SELECT *,sum(CASE WHEN classification='repeat' THEN 1 ELSE 0 END) OVER (PARTITION BY chat_id,user_id ORDER BY created_at,message_id) AS run FROM score_events
), runs AS (
 SELECT chat_id,user_id,run,count(*) FILTER(WHERE classification='original') AS length FROM numbered GROUP BY chat_id,user_id,run
), totals AS (
 SELECT chat_id,user_id,count(*) FILTER(WHERE classification='original') AS originals,count(*) FILTER(WHERE classification='repeat') AS repeats FROM score_events GROUP BY chat_id,user_id
)
UPDATE stats s SET originals=t.originals,repeats=t.repeats,streak=(SELECT length FROM runs r WHERE r.chat_id=s.chat_id AND r.user_id=s.user_id ORDER BY run DESC LIMIT 1),best_streak=(SELECT max(length) FROM runs r WHERE r.chat_id=s.chat_id AND r.user_id=s.user_id) FROM totals t WHERE s.chat_id=t.chat_id AND s.user_id=t.user_id;
CREATE INDEX fingerprints_retention ON fingerprints(chat_id,created_at);
CREATE INDEX actions_retention ON actions(chat_id,created_at);


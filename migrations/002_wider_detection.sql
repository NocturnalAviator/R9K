ALTER TABLE fingerprints DROP CONSTRAINT fingerprints_pkey;
ALTER TABLE fingerprints ADD PRIMARY KEY(chat_id,message_id,kind,hash);
CREATE INDEX messages_normalized_trgm ON messages USING gin (normalized_text gin_trgm_ops);
ALTER TABLE messages ADD COLUMN classification text;
UPDATE messages m SET classification = CASE WHEN EXISTS (
 SELECT 1 FROM fingerprints f WHERE f.chat_id=m.chat_id AND f.message_id=m.message_id
) THEN 'original' ELSE 'repeat' END;
CREATE TABLE sticker_state (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, state jsonb NOT NULL, PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE album_actions (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, media_group_id text NOT NULL, verdict jsonb NOT NULL,
 PRIMARY KEY(chat_id,user_id,media_group_id)
);
CREATE TABLE chains (
 chat_id bigint NOT NULL, message_id bigint NOT NULL, last_at timestamptz NOT NULL,
 users jsonb NOT NULL, length integer NOT NULL, exhausted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(chat_id,message_id),
 FOREIGN KEY(chat_id,message_id) REFERENCES messages(chat_id,message_id) ON UPDATE CASCADE ON DELETE CASCADE
);

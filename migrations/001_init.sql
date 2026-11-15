CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE chats (
 chat_id bigint PRIMARY KEY, type text NOT NULL, title text,
 settings jsonb NOT NULL DEFAULT '{}', bot_rights jsonb NOT NULL DEFAULT '{}',
 joined_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);
CREATE TABLE messages (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 message_id bigint NOT NULL, user_id bigint NOT NULL,
 raw_text text, normalized_text text, kind text NOT NULL DEFAULT 'text',
 media_group_id text, created_at timestamptz NOT NULL, edited_at timestamptz,
 PRIMARY KEY(chat_id,message_id)
);
CREATE TABLE fingerprints (
 chat_id bigint NOT NULL, kind text NOT NULL, hash text NOT NULL,
 message_id bigint NOT NULL, user_id bigint NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(chat_id,message_id,kind),
 FOREIGN KEY(chat_id,message_id) REFERENCES messages(chat_id,message_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX fingerprints_lookup ON fingerprints(chat_id,kind,hash);
CREATE TABLE strikes (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, level double precision NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE actions (
 id bigserial PRIMARY KEY,
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, message_id bigint NOT NULL, action text NOT NULL, rule text NOT NULL,
 matched_message_id bigint, detail jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX actions_message ON actions(chat_id,message_id,id DESC);
CREATE TABLE stats (
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 user_id bigint NOT NULL, originals bigint NOT NULL DEFAULT 0, repeats bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(chat_id,user_id)
);

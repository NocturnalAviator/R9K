CREATE TABLE managed_chats (
 user_id bigint NOT NULL,
 chat_id bigint NOT NULL REFERENCES chats(chat_id) ON UPDATE CASCADE ON DELETE CASCADE,
 PRIMARY KEY(user_id,chat_id)
);

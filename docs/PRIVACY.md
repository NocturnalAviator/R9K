# R9K privacy policy

R9K checks originality separately within each group. We never match content
across chats. We do not sell or share your data.

We store message text and normalized text, fingerprints (hashes of text, links,
media or forward identifiers), Telegram user and message ids, timestamps, display
names and usernames, originality scores, strikes and an audit log of moderation
and settings actions. Short-lived helper records track stickers, albums and
chains. This supports repeat detection, enforcement, scores and explanations.
Names are cached only to display scores; they are not used for matching.

Text lasts for the group's memory window, capped at 90 days. Fingerprints last
for the memory window; with forever memory they remain until the chat is purged.
Audit records last 90 days and weekly scores 26 weeks. Lifetime scores and their
text-free classification history, display names and strikes remain until removal
or a deletion request (strikes are retained after a deletion request). Album
state lasts one day, inactive sticker state 30 days, and expired chains at most
the longer of one day or their configured window. Scheduled cleanup runs every
ten minutes; outages can delay it. Removing the bot purges all chat records after a
7-day grace period. Re-adding it inside that period preserves data.

The operator can access the database. Group admins can inspect a user's last
five moderation actions through reply-/why, including up to 200 characters of a
matched message if text remains. Users can inspect their own latest action.
These explanations use ephemeral notices or private messages. Scores and display
names appear publicly through /me, /top and optional weekly leaderboards.

Use /forgetme in a group to clear your stored text, display cache, scores and
helper records there. In private chat, confirm to do this across all groups.
Fingerprints, identifiers needed to enforce rules, strike state and audit
records remain; the request itself is audited. New messages can create new
records. Removing text disables fuzzy matching against it, but exact fingerprint
matching still works. Deleted text is not copied into audit explanations.

Encrypted backups may retain deleted data until the operator expires them.
The supplied script keeps the newest 14 local backups; the operator must apply
an equivalent retention policy to off-site copies and reapply deletion requests
after a restore. The operator must protect backup keys and database access.

For questions, backup erasure or other privacy requests: <operator contact>.

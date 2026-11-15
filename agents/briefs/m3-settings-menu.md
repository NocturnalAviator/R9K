# Brief: settings menu (milestone 3)

Read `AGENTS.md`, `docs/PLAN.md` and the existing code first, especially `src/settings/schema.ts` and
`src/settings/presets.ts`. Build the admin settings UI: an inline-button menu in a **private chat** with the bot.

## Scope

`src/settings/`, `src/handlers/`, `src/middleware/`, `src/bot.ts`, `migrations/` (new numbered files only), tests,
`README.md`. Do not change detection or enforcement behaviour. Not `docs/PLAN.md`, `AGENTS.md`, `agents/`, `.env*`.

## Flow

- `/settings` in a group, sent by a group admin: the bot records that this user manages this chat (new table,
  `(user_id, chat_id)`) and answers with one short message carrying a URL button
  `https://t.me/<bot username>?start=s_<chat id>` ("Open settings in private"). Non-admins get no answer (the
  command message is left alone).
- `/start s_<chat id>` in private, and `/settings` in private (lists the chats recorded for this user as buttons;
  with exactly one, opens it directly; with none, explains to run `/settings` in the group).
- **Every** menu render and every button press re-checks that the user is currently an admin of the target chat
  (use the admin cache; on failure show "You are no longer an admin of that chat" and drop the record) and that the
  bot is still in the chat. The chat id comes from callback data and is never trusted without this check.
- Use plain inline keyboards with compact, stateless callback data (for example `s:<chatId>:<screen>:<op>:<arg>`,
  at most 64 bytes; chat ids can be 14 digits) rather than session state, so any button on any old message still
  works after a restart. Always `answerCallbackQuery`. Edit the menu message in place; ignore "message is not
  modified" errors.

## Screens

Main screen: chat title, current preset (or "Custom" when settings differ from every preset), a one-line summary,
and buttons to the screens below. Every screen has Back. Values change with buttons only (cycle through sensible
choices or `-` / `+` steps); no free-text input except allow-phrases.

- **Preset**: Relaxed / Classic / Strict, each with a one-line description; choosing one replaces all settings
  except `allowPhrases` after a confirm step.
- **Memory**: 1 h, 24 h, 7 d, 30 d, forever. Note on screen: text is kept at most 90 days regardless.
- **Penalties**: `warnStrikes` (0 to 5), `deleteOnlyStrikes` (0 to 5), `muteBaseSeconds` (2 s, 10 s, 60 s, 5 min,
  1 h), `muteMultiplier` (2, 3, 4, 10), `muteCapSeconds` (1 h, 6 h, 24 h, 7 d, 30 d), `strikeHalfLifeSeconds` (1 h,
  6 h, 24 h, 7 d). Show a preview line of the resulting ladder, e.g. "warn, warn, delete, mute 1 min, 4 min, 16 min
  ... up to 24 h".
- **Detection**: toggles for every boolean detection setting present in the schema (`detectForwards`,
  `detectMedia`, `detectLinks`, `detectNearText`), `nearTextThreshold` (0.6, 0.7, 0.8, 0.9), chain mode and its
  numbers, sticker mode (off / relaxed / normal / strict). Build this screen from what exists in the schema when you
  start; if a setting named here is missing from the schema, skip it and say so.
- **Low-effort filters**: the `lowEffort` toggles and `minLength` (0, 2, 3, 5, 10), if present in the schema.
- **Exemptions**: `exemptAdmins` toggle; allow-phrases list with a remove button per phrase (max 50 phrases, 200
  characters each) and "Add phrase", which sends a `ForceReply` prompt that names the chat; the reply handler
  recovers the chat id from the prompt it replies to (embed it in the prompt text, e.g. a trailing `#<chat id>`),
  re-checks admin status, stores the phrase, and re-sends the screen.
- **Reset strikes**: clears all strikes in the chat after a confirm step.

Settings writes go through one function that validates with the zod schema, saves, and records an `actions` row
(`settings_change`, who, which key, old and new value) for audit.

## Tests

Through `bot.handleUpdate` with the recording API: group `/settings` by admin vs non-admin; deep-link open; a
callback from a user who is not an admin of the chat in the callback data changes nothing; each screen renders;
toggling and stepping values persists and the engine then sees the new setting; preset apply keeps allow-phrases;
"Custom" shown after a manual change; add and remove allow-phrase via ForceReply; reset strikes; callback data
never exceeds 64 bytes for a 14-digit negative chat id.

## Done

`npm run format`, `npm run lint`, `npm run typecheck`, `npm test` pass. Final message per `AGENTS.md`.

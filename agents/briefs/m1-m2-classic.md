# Brief: milestones 1 and 2 (skeleton + classic R9K)

Read `AGENTS.md` and `docs/PLAN.md` first. Build the project skeleton and the classic ROBOT9000 behaviour
(plan milestones 1 and 2). Later briefs add the settings menu, wider detection, scores and launch tooling; shape the
code so they slot in, but do not build them now.

## Scope

You may create or change anything in the repository **except** `docs/PLAN.md`, `scripts/import-token.sh`, `AGENTS.md`,
`CLAUDE.md`, `agents/`. You may extend `.env.example`, `.gitignore` and `README.md`.

## Project setup

- `package.json` (`"type": "module"`, `engines.node >= 20`), strict `tsconfig.json`, ESLint (typescript-eslint, flat
  config) and Prettier. Scripts: `dev` (tsx watch), `build` (tsc to `dist/`), `start`, `migrate`, `format`
  (prettier --write), `lint`, `typecheck`, `test` (vitest run).
- Dependencies: `grammy` (latest 1.x), `@grammyjs/runner`, `@grammyjs/auto-retry`, `@grammyjs/transformer-throttler`,
  `pg`, `@electric-sql/pglite`, `zod`, `pino`. Commit the lockfile.
- Config from environment, validated with zod (`src/config.ts`): `BOT_TOKEN` (required), `DATABASE_URL` (optional),
  `PGLITE_DIR` (default `.data/pglite`), `LOG_LEVEL`. When `DATABASE_URL` is unset the bot runs on a PGlite database
  persisted in `PGLITE_DIR` (this machine has no Docker or Postgres; this is the local dev mode). Load `.env` with
  Node's `--env-file-if-exists` or `process.loadEnvFile`, not a dependency.
- `Dockerfile` (multi-stage, `node:22-alpine`, non-root) and `compose.yaml` (bot + `postgres:17`, database not
  published to the host, named volume, healthcheck, bot runs migrations on start). These cannot be tested here; keep
  them simple and say so in the final message.
- `.github/workflows/ci.yml`: Node 22, `npm ci`, lint, typecheck, test, on push and pull request.
- `README.md`: what the bot is, how to run it locally (PGlite) and with Compose, how to add it to a group, commands.

## Database

- `src/db/`: a `Db` interface (`query(sql, params)`, `tx(fn)`, `close()`) with two implementations: `pg` Pool and
  PGlite. Plain SQL files in `migrations/` (`001_init.sql`, ...) applied in order by a small runner that records
  them in `schema_migrations`; migrations run automatically at startup and via `npm run migrate`.
- `001_init.sql` creates `CREATE EXTENSION IF NOT EXISTS pg_trgm` (PGlite: load its bundled `pg_trgm` contrib
  extension; if that proves impossible, stop and report rather than dropping it) and the tables from the plan:
  - `chats`: chat id (PK), type, title, `settings` jsonb, bot rights snapshot, joined/removed timestamps.
  - `messages`: chat id, message id, user id, raw text, normalized text, kind, `media_group_id`, created/edited
    timestamps; unique (chat id, message id).
  - `fingerprints`: chat id, kind (`text` for now), hash, reference to the `messages` row (cascade), user id,
    created timestamp; index on (chat id, kind, hash).
  - `strikes`: (chat id, user id) PK, level, updated timestamp.
  - `actions`: audit log: chat, user, message id, action, rule, matched message reference, detail jsonb, timestamp.
  - `stats`: (chat id, user id) PK, counters for original and repeated messages (maintained now, used later).
- Telegram ids are `bigint`; handle them as JS numbers (register a parser for `pg`; make PGlite behave the same).

## Settings (schema now, menu later)

`src/settings/schema.ts`: a zod schema with defaults, stored in `chats.settings`, parsed leniently (unknown or
invalid stored values fall back to defaults). Fields needed now:

- `memorySeconds`: number or `null` (forever). How long a message stays "used".
- `warnStrikes` (default 2), `deleteOnlyStrikes` (default 1).
- `muteBaseSeconds` (default 60), `muteMultiplier` (default 4), `muteCapSeconds` (default 86400).
- `strikeHalfLifeSeconds` (default 21600).
- `exemptAdmins` (default true), `allowPhrases`: string[] (default empty).
- `minFuzzyLength` and other later fields are not needed yet.

`src/settings/presets.ts`: `relaxed` (the defaults above, `memorySeconds` 86400), `classic` (`warnStrikes` 0,
`deleteOnlyStrikes` 0, `muteBaseSeconds` 2, multiplier 4, cap 7 days, `memorySeconds` null), `strict` (same as classic
for now). New chats start on `relaxed`.

## Detection (pure, `src/detect/`)

`normalize(text, entities?)`: Unicode NFKC, case-fold (lowercase), remove zero-width and other invisible format
characters, remove `@mentions` (by entity when given, else by `@\w+` pattern), remove punctuation and symbols (keep
letters, digits and emoji), collapse any run of 3 or more of the same character to one (`looooool` -> `lol`,
but `good` stays `good`), collapse whitespace, trim. `fingerprintText(normalized)`: SHA-256 hex. Unit-test
against a table of tricky cases (mixed case, fullwidth forms, zero-width joiners inside words, punctuation-only
differences, emoji-only messages, Cyrillic and CJK text, combining accents).

A message whose normalized text is empty is not checked (media without caption is a later milestone). Use `text`
or, for media, `caption`.

## Engine (`src/enforce/` + `src/detect/`, database-only, no grammY)

`processMessage(db, input, now)` where `input` holds chat id, chat settings, message id, user id, text, entities,
`isEdit`, `userIsAdmin`, `canMute` (chat is a supergroup and the bot may restrict). Returns a `Verdict`:
`{ action: 'none' | 'warn' | 'delete' | 'mute', muteSeconds?, strike?, rule?, matchedMessageId?, matchedAt? }`.
Runs in one transaction:

1. Exempt -> `none`, store nothing: `userIsAdmin && exemptAdmins`; normalized text empty; normalized text equals a
   normalized `allowPhrases` entry. (Commands, service messages, anonymous admins and channel posts are filtered
   out by the handler before the engine.)
2. Look up a `text` fingerprint with the same hash in this chat, from a **different message id**, newer than
   `now - memorySeconds` (no bound when `null`). Lookups always use the current setting and `created_at`, never a
   stored expiry, so changing the memory window takes effect at once.
3. No match -> original: upsert the `messages` row and its fingerprint (for an edit, replace the old fingerprint of
   that message), bump `stats` originals, return `none`.
4. Match -> repeat: store or update the `messages` row but do **not** add a fingerprint; bump `stats` repeats; compute
   the strike (below); append to `actions` (rule `exact_text`, matched message); return the verdict.
   A repeat by the same user who posted the original still counts.
5. An edit of a previously penalised message that is still a repeat of the same match must not strike again
   (check the last action for that message). An edit that turns a clean message into a repeat is penalised.

Strike ladder (`src/enforce/strikes.ts`, pure function plus a small query layer): effective level =
`level * 0.5 ^ (elapsed / strikeHalfLifeSeconds)` (continuous). On a violation `n = floor(effective) + 1`; store
level `n` with `updated = now`. `n <= warnStrikes` -> `warn`; `n <= warnStrikes + deleteOnlyStrikes` -> `delete`;
otherwise `mute` with `m = n - warnStrikes - deleteOnlyStrikes` and
`muteSeconds = min(muteCapSeconds, muteBaseSeconds * muteMultiplier ^ (m - 1))`. If `!canMute`, `mute` degrades to
`delete`. Telegram treats restrictions shorter than 30 s as permanent: the handler must clamp `until_date` to at
least 40 s ahead (keep the unclamped value in the verdict and audit log).

## Bot (`src/bot.ts`, `src/middleware/`, `src/handlers/`)

- `createBot(deps)` builds the grammY bot from injected `db`, `config`, logger and clock, so tests can construct it
  with a fake `botInfo` and an API transformer that records calls instead of using the network. `src/main.ts` wires
  the real thing: migrations, `run(bot)` from `@grammyjs/runner` with `sequentialize` keyed by chat id (so one
  chat's messages are processed in order), `auto-retry`, `transformer-throttler`, `allowed_updates` = message,
  edited_message, my_chat_member, chat_member, callback_query; graceful shutdown on SIGINT/SIGTERM; an error
  boundary that logs and never crashes the process.
- `my_chat_member`: when the bot is added or its rights change, upsert the chat, snapshot its rights, and post one
  onboarding message in the group saying it is active or exactly which rights are missing (admin, delete messages,
  restrict members) and that muting needs a supergroup. When removed, set `removed_at`. Handle the
  group -> supergroup migration (`migrate_to_chat_id`): move the chat's rows to the new id.
- Admin cache: `getChatAdministrators` per chat, cached 10 minutes, invalidated by `chat_member` updates for that
  chat.
- Group messages and edits: skip commands, service messages, messages from bots, anonymous admins
  (`sender_chat` set) and automatic forwards from a linked channel; skip chats where the bot lacks the delete right
  (still record nothing). Otherwise call the engine and apply the verdict:
  - `warn`: react to the message with one emoji via `setMessageReaction` (use an emoji from Telegram's allowed
    reaction list, e.g. 👀) and send a notice.
  - `delete`: `deleteMessage`, send a notice.
  - `mute`: `deleteMessage`, `restrictChatMember` with all send permissions off and `until_date`, send a notice.
  - Notice text: short, says what happened and why, e.g. "Repeat: this was already posted here on <date>. Warning
    1 of 2." / "... Message removed." / "... Muted for 4 minutes." Notices go through one function
    `sendNotice(ctx, userId, text)`: first try an **ephemeral** group message (Bot API 10.2: `sendMessage` with
    `receiver_user_id`, visible only to that user; if the installed grammY types lack the parameter, pass it via
    `ctx.api.raw` with a narrow cast); if that call fails, try a private message to the user; if that fails too,
    give up silently. Never post a normal visible message for a notice.
  - Every Telegram call in enforcement is individually guarded: a failure (message already deleted, rights lost)
    is logged and does not stop the others or throw.
- Commands: `/start` (private chat: what the bot does and how to add it; group: same as `/status`), `/status` (group:
  rights check result, current preset summary), `/privacy` (what is stored: message text per chat for at most the
  chat's memory window and never more than 90 days, fingerprints, strike counts; how to get data removed; full policy
  comes later), `/help`.
- Structured logs with pino; never log message text.

## Tests (Vitest)

- Normalization table (above) and strike ladder maths (decay, each preset's ladder, cap, `canMute` false).
- Engine against PGlite with migrations applied: original then repeat; repeat after the memory window is original
  again; `null` memory never expires; different chats never match each other; admin exemption on and off; allow
  phrases; edit into a repeat is penalised; re-edit of a penalised message is not struck twice; editing an original
  replaces its fingerprint (old text becomes postable); strikes escalate warn -> warn -> delete -> mute with growing
  durations and decay over time.
- Bot integration through `bot.handleUpdate` with fake updates and a recording API transformer: repeat in a
  supergroup produces reaction + ephemeral notice, then delete, then delete + restrict with `until_date` >= 40 s
  ahead; basic group never calls `restrictChatMember`; ephemeral failure falls back to a private message; commands
  and anonymous-admin messages are ignored; `my_chat_member` onboarding reports missing rights; a failing
  `deleteMessage` does not prevent the notice or throw.

Give each test file its own fresh in-memory PGlite; keep the whole suite under about a minute.

## Done

`npm run format`, `npm run lint`, `npm run typecheck`, `npm test` pass. Final message per `AGENTS.md`.

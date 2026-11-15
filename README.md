# R9K

A Telegram group bot that encourages original messages: normalized exact repeats
earn warnings, deletions, then escalating mutes. Each group's history is isolated.
Milestones 1–4 implement text, link, forward, media and near-text matching,
sticker limits, chains, albums, edits, exemptions, strike decay and audit counters.
Milestones 5–6 add scores, explanations, privacy commands, scheduled cleanup and operations tooling. See [Operations](docs/OPERATIONS.md) and [Privacy](docs/PRIVACY.md).

## Local development (PGlite)

Use Node 22 (Node 20.19+ also works with the locked development tools).

1. Run `npm ci`.
2. Create a local `.env` using `.env.example` as a guide. Set `BOT_TOKEN` to your
   BotFather token. Never commit it. Leave `DATABASE_URL` unset.
3. Run `npm run dev`. Migrations run automatically; the bundled PGlite
   `pg_trgm` extension is enabled. Data persists in `PGLITE_DIR`, default
   `.data/pglite`. Run only one process against this directory.

Node loads the environment file; no dotenv dependency is used. These commands
contact Telegram only when you start the bot. No real API or token is used by tests.

`npm run migrate` applies migrations without starting polling. It currently uses
the same validated configuration, including `BOT_TOKEN`.
For a compiled local run: `npm run build`, then `npm start`.
Set `DATABASE_URL` to use PostgreSQL instead of PGlite.

## Docker Compose

Set `BOT_TOKEN` and a strong, URL-safe `POSTGRES_PASSWORD` in your local
environment or Compose's local `.env`, then run:

```sh
docker compose up --build -d
docker compose logs -f bot
```

The non-root Node 22 container runs migrations before polling. PostgreSQL 17 has
a healthcheck and a named volume; its port is not published. Do not run the local
bot and Compose bot simultaneously with the same token. Docker/Compose and the
PostgreSQL adapter have not been exercised against a live server here.

## Add to a group

Add the bot by username, promote it to admin, and enable **delete messages** and
**restrict members**. It reports missing rights when added or promoted.
Muting requires a supergroup. Basic groups degrade mutes to deletion.
Without delete rights, the bot does not process or store messages.
History starts when the bot joins; Telegram does not supply past messages.

- `/start`: introduction in private chats; status in groups.
- `/settings`: group admins get a private settings link; in private, choose a managed chat.
- `/status`: refresh the bot's rights and display the current settings.
- `/privacy`: storage and removal information.
- `/me`: your counters, rate, streak, best streak and decayed strikes.
- `/top`: this ISO week's top ten, at most once per chat per minute.
- `/why`: your latest action privately; admins can reply to inspect five actions.
- `/forgetme`: erase your text and scores here; privately, confirm across all chats.
- `/help`: usage and command list.

New chats use **relaxed**: 24-hour memory, two warning strikes, one delete-only
strike, then 60-second mutes multiplied by four up to one day.
**Classic** and **strict** share permanent fingerprint memory, no
warnings/delete-only strikes, and mutes starting at two seconds, capped at seven
days. Presets are exported in `src/settings/presets.ts` and selectable in the private menu. Invalid stored settings fall back field-by-field to defaults.

Strikes use the brief's continuous decay formula exactly:
`floor(level * 0.5 ** (elapsed / halfLife)) + 1`, with a six-hour half-life.
Even small positive elapsed times can lower the floor of an integer level;
the warning ladder therefore need not advance on every repeat.
Telegram restrictions are clamped to at least 40 seconds; the verdict and audit
record retain the configured duration.

Notices first target only the offending user through an ephemeral group message,
then fall back to a private message. There is no public-notice fallback.
The API payload uses `ephemeral_message_parameters.receiver_user_id`.
Onboarding and /me and /top responses are ordinary chat messages; /why uses private notices.

## Wider detection and filters

Rules run in order: forward, media, exact text, link, near text. Originals store
all available fingerprints; repeats store none. Media uses stable unique file
IDs, with the largest photo size selected. Channel forwards (and chat origins
when a source message ID exists) use source identity; user/hidden-user forwards
have no stable forward fingerprint. Stickers never enter this corpus.

Link entities are canonicalized locally without network requests. With links
enabled, exact matching hashes normalized surrounding text plus the canonical
link set, so different links with the same description remain distinct. Link-only
messages have no text fingerprint. Near matching uses normalized message text,
`SET LOCAL pg_trgm.similarity_threshold`, the `%` predicate and a GIN index on
`messages.normalized_text`; PGlite tests exercise thresholds and isolation.
The query planner may choose a sequential scan for small tables.

Forward/media rules default on. Links and near text default off; classic/strict
enable both. Near text defaults to 0.8 similarity and 20 normalized characters.
Schema defaults use normal stickers (5 per 60 seconds, 3 consecutive, 60-second
same-sticker cooldown). Relaxed uses 10/60, 5, 10; strict uses 3/120, 2, 300.
Custom mode uses stored numbers; off imposes no limits. Attempts advance the run
and cooldown, including deleted stickers; only whole available tokens are spent.
A non-sticker resets the run. Sticker violations delete with a private notice
and no strike.

Chains default to collapse: timely repeats involving multiple users are deleted
silently without strikes. Classic/strict disable chains. Tolerate allows up to
`chainMaxLength` total messages including the original, then enforces normally;
a returning participant ends tolerance for the burst. A gap greater than
`chainWindowSeconds` starts a fresh burst. Chains share the matched original's
identity across its fingerprints; near-text matches do not form chains.
Albums keep the first repeat's action per chat/user/album; later repeated items
are deleted if that action deleted or muted, without another strike or notice.

Low-effort rules run before repeats on text messages, excluding media captions
and stickers. All default off. Strict enables minimum length 3, emoji-only and
all-caps filtering; one-word filtering applies only to replies when enabled.
Violations delete with a private notice, no strike and no corpus entry.
Detection and low-effort options are editable in the private settings menu.

## Storage and implementation

Detection and strike functions have no Telegram dependency. The engine takes an
explicit clock value and makes each decision in a transaction, locking the chat
row. Runner updates are also serialized per chat. Fingerprints use SHA-256;
lookup always applies the current memory window to the original creation time.
Editing an original replaces its fingerprint. Re-editing a penalized message
that still matches the same original does not add another strike or repeat count.
Edits change counters only when classification changes, transferring the count
between originals and repeats.

Text and normalized text are cleared on startup and every ten minutes once older than
the chat's memory window or 90 days, whichever is shorter. Cleanup resumes on
startup after downtime. Fingerprints remain available for permanent memory.
This is periodic erasure, not exact-deadline deletion; text may remain until the
next sweep. Changing a memory window cannot recover already erased text.
Use /forgetme to erase stored text, display names and scores while retaining fingerprints and strikes. Removed chats are purged after seven days. Logs contain only
metadata, never message text, tokens or raw API errors.

Schema metadata and the retention job's chat-directory enumeration are global
control queries; all message lookups and mutations are scoped by chat id.
Group-to-supergroup migration cascades IDs through every table. A destination
with existing messages is rejected instead of silently combining histories.

## Checks

```sh
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use a fresh in-memory PGlite per database test file, real migrations and a
recording grammY API transformer. They never contact Telegram. The suite runs
serially across files to bound WASM memory use. The lockfile is included for
reproducible installs. Development tool versions are selected to keep dependency
licenses within MIT, Apache-2.0, BSD and ISC. The minimatch override keeps its
ISC-licensed 9.x line; Vite 7 avoids a required MPL-licensed CSS dependency.

The current full dependency audit reports seven moderate development-only
findings rooted in minimatch's glob amplification advisory. The available
patched major uses a license outside this repository's allowlist, so that
upgrade is not applied. The production-only audit reports no vulnerabilities.

## Private settings menu

Run `/settings` as an admin in a group, then use **Open settings in private**.
The deep link also works before the group is recorded. Private `/settings`
opens your only managed chat directly or lists your chats. Access uses the admin
cache (ten-minute TTL, invalidated by membership updates) and checks the bot's
current membership on every button press and render. Failed access removes the
user's directory record. The directory lookup is user-scoped; all settings and
audit mutations are chat-scoped.

Buttons cycle through displayed values and edit the message in place. Presets
replace all options except allow-phrases after confirmation. The preset label
is computed by comparing all current settings with the presets; any difference
(including allow-phrases) shows **Custom**. Reset strikes requires confirmation and clears only that chat.
Penalties preview the configured ladder before decay and Telegram's minimum
restriction duration. Chain windows cycle through 10/30/60/300 seconds, chain
lengths through 2/3/5/10/20, and minimum fuzzy length through 10/20/40/80.

Allow-phrases support up to 50 entries of 200 Unicode characters each, displayed
five per page. Add with a reply to the bot's chat-labelled ForceReply prompt;
duplicate phrases are ignored. Removal buttons identify the phrase, so old menus
cannot accidentally remove another entry after list changes. Callbacks and reply
prompts work after a restart without sessions. Settings changes validate against
the schema and atomically record actor, key, old value and new value in `actions`.
The bot uses plain inline keyboards rather than the menu plugin listed in the
plan, as required by the milestone 3 brief.

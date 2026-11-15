# R9K bot: plan

A public Telegram bot that enforces ROBOT9000-style originality in group chats, with graduated penalties, admin-tunable tolerances, and positive incentives for original posting.

## Decisions

| Area | Decision |
|---|---|
| Audience | Public, multi-tenant: anyone can add the bot to their group |
| Stack | TypeScript, Node 22 LTS, grammY 1.x, PostgreSQL 17 |
| Updates | Long polling via `@grammyjs/runner` (no domain, TLS, or inbound port) |
| Enforcement | Graduated: warn, then delete, then escalating mute |
| Repeat detection | Exact text, near-duplicates, links, forwards, media; stickers on a separate tolerance model |
| Storage | Full message text, per chat |
| Admin UX | Inline-button settings menu in a private chat with the bot, with presets |
| Hosting | Docker Compose on owned hardware for development, same stack moved to a VPS |

## Platform constraints that shape the design

- The bot must be a group **admin** with *delete messages* and *restrict members* rights. Admin bots receive every message regardless of privacy mode. Onboarding checks these rights and tells the admin exactly what is missing.
- Muting (`restrictChatMember`) works only in **supergroups**, and never on admins or the owner. In basic groups the bot degrades to delete-only and says so.
- Bots cannot read history. The corpus starts when the bot joins. An optional later feature is importing a Telegram Desktop chat export.
- Edits arrive as `edited_message` and must be re-checked, otherwise editing a message into a repeat evades the filter.
- Albums arrive as separate messages sharing a `media_group_id` and are judged as one unit.
- Sending is limited to roughly 20 messages per minute per group. The bot therefore warns with a reaction (`setMessageReaction`) instead of a text reply, and batches anything it does say.
- Bot API 10.2 added **ephemeral messages**: `sendMessage` with `receiver_user_id` posts in the group but is visible only to that user and the bot (verified in the official changelog). Repeat notices use these, so warnings never clutter the chat. grammY 1.45+ covers 10.2.

Current versions as of 2026-11-15: Bot API 10.4 (2026-11-09, widgets and TON, nothing relevant here); grammY 1.46.0 supports 10.3. grammY 2.0 is in beta on JSR only; stay on 1.x and migrate once it is stable.

## Detection pipeline

Each incoming message is reduced to one or more **fingerprints**, looked up within the chat's memory window, then stored.

1. **Normalize text**: Unicode NFKC, case-fold, strip zero-width characters and punctuation, collapse whitespace and character runs (`looooool` to `lol`), remove mentions.
2. **Exact match**: hash of the normalized text, indexed per chat.
3. **Near-duplicate**: Postgres `pg_trgm` trigram similarity against the chat's stored text, with a per-chat threshold. Applied only above a minimum length; short messages are exact-match only, since fuzzy matching on five characters is noise.
4. **Links**: canonicalize (lowercase host, drop tracking parameters and fragments, unwrap common shorteners' obvious forms) and fingerprint the URL separately from surrounding text.
5. **Forwards**: fingerprint by `forward_origin` (source chat and message ID).
6. **Media**: `file_unique_id` catches exact re-sends at no cost. Perceptual hashing for re-uploaded images is a later phase, since it requires downloading files.
7. **Stickers**: not treated as one-shot content. Each user has a sticker budget (token bucket: N stickers per window) plus a cap on consecutive stickers and a short per-sticker cooldown. Admins pick Off / Relaxed / Normal / Strict, with the numbers editable.

Exemptions: admins (configurable), bot commands, service messages, and a per-chat allowlist of phrases.

## Enforcement

Each user has a per-chat strike level that decays over time.

| Strike level | Action |
|---|---|
| 1 to N (default 2) | Warn: reaction on the message, notice to the user |
| Next | Delete the message |
| Beyond | Delete and mute; duration = base x multiplier^level (classic: 2 s x 4^n), capped |

Decay follows the original: the level halves every 6 hours by default. Every number is per-chat. Presets: **Relaxed** (warn-heavy, 24 h memory), **Classic** (delete and mute at once, permanent memory), **Strict** (classic plus low-effort filters).

**Flood and chain control**: when several users post the same fingerprint inside a short burst, treat it as one chain event. Admins choose whether chains are tolerated up to a length (a running joke) or collapsed (delete all after the first, no strikes), which keeps a raid from muting half the chat.

## Beyond R9K

- **Memory window**: how long a message stays "used": forever, 30 days, 24 hours, custom.
- **Low-effort filters**, each a toggle with a tolerance: minimum length, emoji-only, all-caps, one-word replies.
- **Originality scores**: per-user originality rate, streaks, weekly leaderboard posted on a schedule or on `/top`.
- **Explainability**: every action records which rule fired and what it matched, shown to the user and to admins via `/why`. This is the main payoff of storing full text.

## Data and privacy

Full-text storage makes this bot a chat logger for every group that adds it, which carries real obligations for a public bot:

- Publish a privacy policy and a `/privacy` command (Telegram's bot developer terms require a policy).
- Text is retained only as long as the chat's memory window, with a hard server-side cap of 90 days. "Forever" memory keeps the fingerprint and drops the text after the cap.
- `/forgetme` deletes a user's stored text; removing the bot from a chat purges that chat after a grace period.
- Encrypted disk on the host, database not exposed outside the Compose network, encrypted off-site backups.
- Data is strictly partitioned by chat. No cross-chat matching.

Core tables: `chats` (settings JSON, preset), `messages` (chat, user, message ID, text, timestamps), `fingerprints` (chat, kind, hash, message ref, expiry), `strikes` (chat, user, level, updated), `actions` (audit log), `stats` (per-user counters).

## Architecture

```
src/
  bot.ts            grammY setup, runner, error boundary
  middleware/       chat loading, admin cache, rights check
  detect/           normalize, fingerprints, near-dup, links, stickers, chains
  enforce/          strike ladder, delete, mute, notices
  settings/         inline menu, presets, schema (zod)
  stats/            scores, leaderboards
  db/               migrations, queries
```

grammY plugins: `runner` (concurrent polling, sequential per chat), `auto-retry` and `transformer-throttler` (rate limits and 429s), `menu` (settings UI), `parse-mode`. Detection functions are pure and unit-tested with Vitest against a corpus of tricky cases.

## Server

- **Development**: `docker compose up` on owned hardware runs the bot and Postgres. Use a separate BotFather token and a private test supergroup, never the production bot.
- **Production**: a small VPS (2 vCPU, 2 to 4 GB RAM is ample to start; Postgres is the only real consumer). Same Compose file with a production override.
- **Deploy**: GitHub Actions builds an image to GHCR on merge to `main`; the VPS pulls and restarts. Secrets live in an env file on the host, not in the repository.
- **Operations**: nightly `pg_dump` to encrypted object storage, a healthcheck endpoint with an uptime ping, structured logs, and an alert to a private admin chat on errors.
- **Scaling path**: long polling on one process handles a large number of chats. If needed later, switch to webhooks behind Caddy and split detection into workers; nothing in the design blocks this.

## Milestones

1. **Skeleton**: project, Compose, migrations, bot joins a group, verifies rights, logs messages.
2. **Classic R9K**: normalization, exact match, edits, strike ladder, delete and mute.
3. **Settings**: private-chat menu, presets, memory window, exemptions.
4. **Wider detection**: near-duplicates, links, forwards, media IDs, sticker budgets, chains.
5. **Incentives**: scores, leaderboards, `/why`, low-effort filters.
6. **Public launch**: privacy policy, `/forgetme`, purge on removal, backups, monitoring, VPS deploy.

## Needed from the owner

- Run `scripts/import-token.sh` on the development machine to copy the bot token into `.env`.
- Add the bot to the test group by username and promote it to admin (bots cannot join through invite links).
- Text retention hard cap: **90 days** (decided).
- VPS provider and region when milestone 6 approaches.

# Brief: scores, `/why`, privacy tooling and operations (milestones 5 and 6, code parts)

Read `AGENTS.md`, `docs/PLAN.md` and the existing code first. Detection, enforcement and the settings menu exist.
This brief adds incentives, explainability, the data-privacy commands and jobs, and operations tooling.

## Scope

`src/`, `migrations/` (new numbered files only), tests, `README.md`, `docs/PRIVACY.md` (new), `docs/OPERATIONS.md`
(new), `scripts/` (new files only), `compose.yaml`, `compose.prod.yaml` (new), `Dockerfile`, `.github/workflows/`,
`.env.example`. Not `docs/PLAN.md`, `AGENTS.md`, `agents/`, `scripts/import-token.sh`.

## Scores

- Extend `stats` (new migration): current streak of consecutive originals, best streak, and per-ISO-week counters
  (a `stats_weekly` table keyed by chat, user, week start date in UTC is fine). An original extends the streak; a
  strike-carrying repeat resets it; no-strike deletions (chains, stickers, low-effort) change nothing. Edits change
  counters only when a message's classification changes.
- Keep a `users` display cache per chat (user id, first name, username, updated) refreshed from incoming messages,
  used only to render names; it is personal data and is covered by `/forgetme` and purges.
- `/me` in a group: your originals, repeats, originality rate, streak, best streak, current strike level (decayed).
- `/top` in a group: this week's top 10 by originals (ties: higher originality rate), with rate and streak; plain
  names without @-mentions so nobody is pinged. Rate-limit to one per chat per 60 s (silently ignore extra calls).
- Setting `leaderboard`: `{ weekly: boolean }` (default false). When on, the bot posts the previous week's top 10
  once, on Monday after 09:00 UTC (a job that checks every few minutes and records the last posted week per chat so
  restarts never double-post). Add the toggle to the settings menu.
- `/me`, `/top` and `/why` answers in groups are ordinary visible replies to the command.

## `/why`

- For a user: in a group, `/why` shows the caller their most recent action in this chat, sent through `sendNotice`
  (ephemeral, else private): rule, what it matched (the matched message's date and, if its text is still stored, a
  quote of at most 200 characters), the action taken and strike number.
- For admins: `/why` as a **reply** to any user's message shows that user's last 5 actions in this chat in the same
  format, also through `sendNotice` to the admin. If the original text is gone, say "text no longer stored".

## Privacy

- `/forgetme` in a group: for the caller in this chat, null out stored text (`raw_text`, `normalized_text`) of their
  messages, delete their display-cache row and stats, and keep only fingerprints (hashes) and strike state so
  enforcement still works. In private chat: the same across every chat, after a confirm button. Answer with what
  was removed (counts). Record an `actions` row (`forget`).
- **Purge on removal**: when the bot is removed from a chat, `removed_at` is set (already done). A job deletes every
  row for chats removed more than 7 days ago (all tables). If the bot is re-added within the grace period,
  `removed_at` is cleared and nothing is lost (check that this already works).
- **Retention job** (extend `src/db/retention.ts`): besides clearing text past `min(memorySeconds, 90 days)`,
  delete fingerprints older than the chat's memory window, delete `messages` rows that have no text and no
  fingerprints, delete `actions` older than 90 days and weekly stats older than 26 weeks. Work in bounded batches so
  a large chat cannot hold a long lock. Keep per-chat scoping. Also clean the helper tables that currently grow
  without bound: `album_actions` (add a timestamp; drop rows older than a day), `chains` whose window has long
  passed, and `sticker_state` untouched for 30 days. `/forgetme` and the chat purge must cover these tables too.
- `/privacy`: short summary plus a link to the policy. `docs/PRIVACY.md`: a plain-language privacy policy covering
  what is stored (message text per chat, fingerprints, user ids, display names, strikes, audit log), why, how long
  (memory window, 90-day cap, 7-day purge after removal), who can see it (the operator; group admins only through
  `/why`), no cross-chat matching, no selling or sharing, `/forgetme`, and a contact placeholder
  `<operator contact>` for the owner to fill in. The policy URL comes from config `PRIVACY_URL` (default: the
  GitHub URL of `docs/PRIVACY.md` on `main` in `NocturnalAviator/R9K`).

## Operations

- **Healthcheck**: optional HTTP server on `HEALTH_PORT` (off when unset) answering `GET /healthz` with 200 when the
  database answers `SELECT 1` and the last successful `getUpdates` cycle or processed update was under 2 minutes
  ago (track via a transformer on `getUpdates`), else 503. Bind `0.0.0.0`; Compose uses it as the bot's
  healthcheck without publishing the port.
- **Error alerts**: config `ALERT_CHAT_ID` (optional). Errors caught by the error boundary and failed jobs send a
  short message there (error summary only, never message text), rate-limited to one per minute with a count of
  suppressed errors.
- `compose.prod.yaml`: override that uses the published image `ghcr.io/nocturnalaviator/r9k:latest` instead of
  building, `env_file`, log rotation.
- `.github/workflows/deploy.yml`: on push to `main`, build and push the image to GHCR (tags `latest` and the commit
  SHA) using `GITHUB_TOKEN`. No server access from CI; the server pulls.
- `scripts/backup.sh`: `pg_dump` from the Compose `db` service, compressed and encrypted with `age` to a recipient
  given in `BACKUP_AGE_RECIPIENT`, written to `BACKUP_DIR` with a dated name, keeping the newest 14;
  `scripts/restore.sh` as its inverse with a confirmation prompt. `shellcheck`-clean, `set -euo pipefail`.
- `docs/OPERATIONS.md`: VPS setup from zero (Docker install, clone, `.env`, `docker compose -f compose.yaml -f
  compose.prod.yaml up -d`), updating, backups via cron and off-site copy, restoring, the healthcheck and an uptime
  ping, alert chat setup, disk encryption note. State clearly that the Compose stack, scripts and deploy workflow
  were written without a Docker host to test on.

## Tests

Streak and weekly counters through the engine; `/me`, `/top` (ordering, no mentions, rate limit), weekly posting
job (posts once, not twice after restart, not when off); `/why` for self and for admin-by-reply, with stored and
expired text, non-admin reply-`/why` shows only own data; `/forgetme` in group and private (text gone, fingerprints
kept, a later repeat of the forgotten message is still detected); purge after grace period and re-add inside it;
retention job (each deletion rule, other chats untouched); healthcheck 200/503; alert rate limit.

## Done

`npm run format`, `npm run lint`, `npm run typecheck`, `npm test` pass. Final message per `AGENTS.md`.

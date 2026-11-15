# Rules for coding agents

R9K is a public Telegram bot enforcing ROBOT9000-style originality in group chats. Design: `docs/PLAN.md`.

- **Scope**: touch only the paths your brief lists. If the brief's explicit wording conflicts with a rule here or
  with `docs/PLAN.md`, follow the brief and note the conflict in your final message.
- **No commits.** Leave changes in the working tree. Never read, print, or create `.env`; never contact the
  Telegram API (tests use a fake API transport; there is no token in your environment).
- **Stack**: TypeScript (strict, ESM, NodeNext), Node >= 20, grammY 1.x, PostgreSQL 17 via `pg`; tests run against
  PGlite (`@electric-sql/pglite`, in-process Postgres) so no database server is needed. Dependencies must be
  MIT/Apache-2.0/BSD/ISC licensed.
- **Structure**: detection and enforcement decisions are pure or database-only functions that take the current time
  as an argument and never touch grammY; Telegram calls live in thin handlers. All SQL goes through the `Db`
  interface in `src/db/`; every query is scoped by `chat_id` (no cross-chat matching, ever).
- **Privacy**: never log message text or tokens. Log ids, rule names and counts only.
- **Checks before you finish**: `npm run format`, `npm run lint`, `npm run typecheck`, `npm test` all pass.
  Do not weaken or delete an existing test to make it pass; if a test contradicts the brief, say so.
- **Final message**: what you built, decisions you made where the brief was silent, anything unfinished or
  unverified, and the check results.

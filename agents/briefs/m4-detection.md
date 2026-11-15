# Brief: wider detection (milestone 4) and low-effort filters

Read `AGENTS.md`, `docs/PLAN.md` and the existing code first (`src/detect/`, `src/enforce/`, `src/handlers/`,
`src/settings/`, `migrations/`). Milestones 1 and 2 are done: exact-text repeats, strike ladder, enforcement.
This brief widens what counts as a repeat. The settings menu comes in a later brief: add settings to the schema
and presets only.

## Scope

`src/`, `migrations/` (new numbered files only; never edit an applied migration), `tests/` (or wherever tests live),
`README.md`, `package.json`/lockfile if a dependency is truly needed (prefer none). Not `docs/PLAN.md`, `AGENTS.md`,
`agents/`, `.env*`, `scripts/`.

## Model

A message now yields **several fingerprints** (`kind`, `hash`), and may also be checked by rules that are not
fingerprints. The engine input gains what it needs (forward origin, media ids, sticker id, `media_group_id`, link
entities); the handler extracts these from the grammY message, the engine stays grammY-free.

A message is a repeat if any **enabled** rule matches inside the memory window. Check in this order and report the
first hit as the verdict's `rule`: `forward`, `media`, `exact_text`, `link`, `near_text`. As before, an original
stores all of its fingerprints, a repeat stores none, and the match must come from a different message id.
Messages with no text are now processed when they carry any fingerprint.

### Rules and settings (add to the zod schema with these defaults)

- `detectForwards` (default true). Kind `forward`: for `forward_origin` of type `channel` or `chat` with a message
  id, hash of origin type + origin chat id + message id. For `user` / `hidden_user` origins there is no stable id:
  no forward fingerprint (text and media rules still apply).
- `detectMedia` (default true). Kind `media`: `file_unique_id` of a photo (the largest size), video, animation,
  document, audio, voice or video note. Stickers are excluded (see below).
- `detectLinks` (default false; true in `classic` and `strict`). Kind `link`, one fingerprint per distinct URL in
  the text or caption (`url` and `text_link` entities). Canonicalize in a pure function `canonicalizeUrl`: add
  `https://` when the scheme is missing, lowercase scheme and host, drop `www.` and a trailing dot, drop default
  ports, drop the fragment, drop tracking parameters (`utm_*`, `fbclid`, `gclid`, `igshid`, `si`, `ref`,
  `ref_src`, `mc_cid`, `mc_eid`, `yclid`, `msclkid`), sort the remaining query parameters, strip a trailing slash
  from the path, treat `http` and `https` as the same. Map obvious equivalent forms: `youtu.be/ID`,
  `youtube.com/shorts/ID`, `m.youtube.com/watch?v=ID` -> `youtube.com/watch?v=ID` (keep only `v`);
  `mobile.twitter.com`, `twitter.com`, `x.com` -> `x.com`; `m.` and `mobile.` host prefixes dropped; `old.reddit.com`
  -> `reddit.com`. No network requests (no redirect following). When a message has links, the `exact_text`
  fingerprint is computed on the text with the URLs removed; if nothing but links remains, only link fingerprints
  apply.
- `detectNearText` (default false; true in `classic` and `strict`), `nearTextThreshold` (default 0.8, range
  0.5 to 0.95), `minFuzzyLength` (default 20 normalized characters). Rule `near_text`: `pg_trgm` similarity between
  the normalized text and the chat's stored normalized texts that are originals (have a `text` fingerprint) inside
  the memory window; skipped when the normalized text is shorter than `minFuzzyLength`. Must use the trigram GIN
  index (new migration: `gin (norm_text gin_trgm_ops)`; set `pg_trgm.similarity_threshold` with `SET LOCAL` inside
  the transaction and use the `%` operator, then pick the most similar row). The verdict carries the similarity.
  Verify that it works on PGlite; if `SET LOCAL` or the operator misbehaves there, fall back to
  `similarity(...) >= $n` and say so.
- **Albums**: messages sharing a `media_group_id` are one unit for penalties. Each item is checked and stored on its
  own, but a user receives at most one strike and one notice per `media_group_id`; later repeated items of the same
  album get the same action as the first (deleted if the first was deleted or muted) without another strike.

### Stickers (separate model, never fingerprinted)

Setting `stickers`: `{ mode: 'off' | 'relaxed' | 'normal' | 'strict' | 'custom', budget, windowSeconds,
maxConsecutive, cooldownSeconds }`. Mode fills the numbers: relaxed 10 per 60 s / 5 in a row / 10 s per-sticker
cooldown; normal 5 per 60 s / 3 / 60 s; strict 3 per 120 s / 2 / 300 s; `custom` uses the stored numbers. Default
`normal`; `relaxed` preset uses relaxed, `strict` preset uses strict. `off` means stickers are never restricted.

Per (chat, user) state in a new table: token bucket (capacity `budget`, refilling continuously at
`budget / windowSeconds`), count of consecutive stickers (reset when the user sends any non-sticker message), and
the last time the user sent each recent sticker (`file_unique_id`; prune entries older than the cooldown). A
sticker violates when the bucket is empty (`sticker_budget`), the run exceeds `maxConsecutive` (`sticker_run`), or
the same sticker is re-sent inside the cooldown (`sticker_cooldown`). A violation deletes the sticker and sends a
notice, with **no strike**; it is recorded in `actions`. A new verdict action `delete_nostrike` (or equivalent) is
fine. Admin exemption applies. Pure bucket maths with the time passed in; unit-test it.

### Chains

Settings `chainMode`: `'off' | 'tolerate' | 'collapse'` (default `collapse`; `classic` and `strict` use `off`),
`chainWindowSeconds` (default 60), `chainMaxLength` (default 5).

A chain forms when a repeat (any fingerprint rule) arrives within `chainWindowSeconds` of the previous message in
the same chain (the original or the latest repeat of it) **and at least two distinct users** are involved once
this message is counted. Track what is needed on the matched fingerprint or a small table.

- `off`: normal enforcement.
- `tolerate`: chain messages are allowed with no penalty until the chain holds `chainMaxLength` messages (original
  included) or the same user posts in it twice; after that, normal enforcement.
- `collapse`: chain repeats are deleted with no strike and no notice (action recorded as rule `chain`).

A single user repeating themselves is never a chain.

### Low-effort filters (plan milestone 5, engine part)

Setting `lowEffort`: `{ minLength: number (0 = off), emojiOnly: boolean, allCaps: boolean, oneWord: boolean }`, all
off by default; `strict` preset: `minLength` 3, `emojiOnly` true, `allCaps` true, `oneWord` false. Checked before
repeat detection on text messages only (not media, not stickers): `min_length` (normalized length below the
minimum), `emoji_only` (no letters or digits after normalization, at least one emoji), `all_caps` (at least 8
letters and every cased letter uppercase in the original text), `one_word` (a single word, when the message is a
reply). A hit deletes the message with a notice and **no strike**, and the message is not stored.

## Notes on the existing code

- `fingerprints` has primary key `(chat_id, message_id, kind)`; a message can now hold several `link`
  fingerprints, so a new migration must change the key (for example to include `hash`).
- The normalized text column is `messages.normalized_text`. Set `messages.kind` meaningfully (`text`, `photo`, ...).
- `actions.matched_message_id` has no foreign key on purpose (messages get purged); keep it that way.
- Notices (`src/handlers/enforcement.ts`): word each rule plainly, e.g. "Repeat: this link / this forward / this
  media / a very similar message was already posted here on <date>", "Sticker limit: ...", "Too short: ...". Keep
  them one or two sentences. Notices stay ephemeral-or-private only (`sendNotice`).
- `stats` currently counts an edit of an original as another original. Fix: an edit changes counters only when the
  message's classification changes (original -> repeat or repeat -> original).
- The handler currently returns early when a message has no text; that must go for media, forwards and stickers.

## Tests

- `canonicalizeUrl` table: every rule above, plus URLs that must stay distinct (different paths, different
  non-tracking query values, different YouTube ids).
- Engine on PGlite: each rule's hit and miss; rule precedence; rules disabled by setting; link repeat with different
  surrounding text; same text with different links is not an `exact_text` repeat when links are on;
  near-duplicate above and below threshold, below `minFuzzyLength`, across chats (never), outside memory window;
  album gives one strike; sticker budget, run and cooldown with refill over time; chain modes (collapse deletes
  without strikes, tolerate allows up to the limit then enforces, single-user repeat is not a chain, slow repeats
  outside the window are not a chain); each low-effort filter.
- Bot integration (fake updates, recording API): a re-sent photo is handled; a forwarded channel post repeated;
  sticker spam deleted without `restrictChatMember`; collapse-mode chain deletes without notices.
- Existing tests keep passing; where an existing expectation changes because of this brief (for example the default
  `chainMode` now collapses a fast two-user repeat), adjust the test's setup rather than its assertion and list each
  such change in the final message.

## Done

`npm run format`, `npm run lint`, `npm run typecheck`, `npm test` pass. Final message per `AGENTS.md`.

# CLAUDE.md — Margin

## What this is
Margin is a personal vocabulary-capture app: catch an unknown word while reading a
physical book, look it up, and keep it — tagged to the book. Single-user, personal tool.

## Current state
- Milestones M0 (installable PWA), M1 (typed lookup), M2 (save/list/filter/delete via
  IndexedDB), M3 (voice input), and M5 (polish) are DONE. Also shipped ahead of plan:
  pronunciation audio playback and same-word dedup across books (saving a known word
  merges books instead of duplicating the entry).
- M5 polish specifically: an offline-aware error message (checks `navigator.onLine` rather
  than queueing/retrying failed lookups — lookups are inherently online-only, so this was
  scoped down from "offline queueing"), an in-app install button (`beforeinstallprompt`),
  and a dark theme via `prefers-color-scheme` that keeps the warm-paper/oxblood identity.
- **M4 is DONE and live as of 2026-07-24** — backed by Gemma 4 (26B MoE, `gemma-4-26b-a4b-it`)
  via Google's free-tier Gemini API, not Claude Haiku as originally planned. The Cloudflare
  Worker (`worker/`) is deployed at `https://margin-llm-proxy.debashis9.workers.dev`, with
  `GEMINI_API_KEY` stored as a Worker secret (never in this repo) and `ALLOWED_ORIGIN` set to
  the live GitHub Pages origin. `AI_ENABLED = true`. UI: a Dictionary/AI toggle at the top of
  the result card — Dictionary shows by default (unchanged, including the multi-sense
  picker); switching to AI lazily fetches a Gemma-generated, book-context-aware definition
  the first time it's opened for that word (not on every lookup), then caches it so
  switching back and forth afterward is instant. Both tabs have their own independent "Save
  to list" button (`saveEntry`/`saveAIResult`), and the app's own `.card` element is reused
  across tab switches (not rebuilt) so the CSS entrance animation doesn't retrigger on every
  click. The originally-planned Claude Haiku path (`/define` on the same Worker) still
  exists in code but the Anthropic key backing it has zero credits — effectively unused;
  Gemma won on cost (free vs ~$0.0015/lookup) after a deliberate latency-tuning pass (see
  below) closed the gap that made it look impractical at first.
- **Gemma 4 latency was tuned down ~6x before shipping.** An unoptimized request (full
  prompt, default thinking, non-streaming) took ~19s and burned 770 tokens on internal
  reasoning versus 78 on the actual answer. Fixed via `generationConfig.thinkingConfig:
  {thinkingLevel: "minimal"}` (verified live — `thinkingBudget: 0`, which works on other
  Gemini models, is flatly rejected for Gemma 4), `maxOutputTokens: 300`, a trimmed
  Gemma-only system prompt (separate from the Claude path's, which doesn't need
  JSON-formatting instructions since Anthropic's structured outputs feature guarantees the
  shape), and switching from a blocking `generateContent` call to `streamGenerateContent`
  so time-to-first-token is observable at all. Result: ~2.8-3.2s total, ~1.2-1.5s to first
  token. One real bug hit along the way: this API's SSE stream uses `\r\n` line endings, not
  `\n` — a naive frame parser silently produces no output without that fix.
- **Multi-sense lookup, done 2026-07-23.** `pickBest()` used to grab only the free
  dictionary's `meanings[0]`/`definitions[0]`, silently dropping every other sense — e.g.
  "incandescent" showed the rare noun sense ("an incandescent lamp or bulb") instead of the
  everyday adjective meaning sitting right next to it in the same API response. Now every
  sense across every part of speech is collected into a `senses` array, and `render()` shows
  all of them grouped by part of speech with a "Save this sense" button each, whenever
  there's more than one. A single-sense word (or an AI-generated result, which already
  picked one sense via book context) still renders the original single-card view unchanged.
  Prototyped first on the (now-obsolete) `experiment/multi-sense-lookup` branch against the
  local IndexedDB path before being carried over to `main` with real Supabase auth/storage
  untouched.
- **Phase 4 (flashcards + quiz) is DONE.** A "Practice" button on the saved-words list opens
  a session scoped to whatever book is currently filtered. Flashcards show one word at a
  time (tap to flip and reveal the meaning); quiz is multiple-choice, with the 3 wrong
  answers drawn from your other saved words' real definitions (preferring the same part of
  speech so they're not trivially guessable) — no AI, no network call, works entirely off
  what's already in IndexedDB. Needs 1+ saved word for flashcards, 4+ for quiz.
- **Phase 2 (cloud sync) is DONE.** Supabase JS v2 (CDN, no build step) gates the whole app
  behind email magic-link sign-in — signed out shows only a sign-in card, signed in shows
  the normal app plus an email + Sign out strip. `saveEntry`/`getEntries`/`deleteEntry` now
  read/write a Supabase `entries` table (RLS-scoped to the signed-in account via
  `auth.uid()`) instead of IndexedDB, so saved words follow you across devices. Public
  sign-up is intentionally off — only emails added under Authentication → Users in the
  Supabase dashboard can sign in (`shouldCreateUser: false` on the client, enforced
  server-side by the project's disabled-signups setting). **Since 2026-07-23, this is also
  enforced at the database level**, not just the project's signups toggle: a
  `public.allowed_emails` table (RLS-locked, no anon/authenticated access, managed only from
  the SQL Editor/dashboard) plus a `before insert on auth.users` trigger
  (`check_allowed_email()`) rejects account creation for any email not on the list. This
  changes the invite order: **add the email to `allowed_emails` first, then "Add user" in the
  dashboard** — the "Add user" action itself is an insert into `auth.users`, so it now goes
  through the same check and fails if done first. The old IndexedDB code is kept
  as `openDBLocal`/`saveEntryLocal`/`getEntriesLocal`/`deleteEntryLocal` — unused, not
  deleted, for a Phase 2b offline-caching pass. One known simplification: saving a word
  you've already saved no longer merges the book into the existing row (the old IndexedDB
  version did) — it's a plain insert, so the same word saved from two books now makes two
  rows. Revisit if that's missed in practice.
- Live and installed on Windows and Android; hosted via GitHub Pages, fully up to date with
  `main` (last pushed 2026-07-23, includes Phase 2, the invite-only trigger, and multi-sense
  lookup). SMTP: Gmail (debashis9@gmail.com + a Google App Password), not Resend — Resend
  needs a verified domain to email anyone but the signup address itself, and buying one
  solely to unblock it wasn't worth it for a personal/family-tester app.

## Picking up next session
- **Decided: not swapping the dictionary API source, for now.** Looked at
  freedictionaryapi.com (same Wiktionary data as today, no key, better-structured response)
  and Wordnik (genuinely different curated sources — AHD, Century, WordNet — needs a free
  API key) as alternatives to the current dictionaryapi.dev, prompted by a real quality
  complaint ("incandescent" showing a nonsensical definition). Root cause turned out to be
  an app-side bug (grabbing `meanings[0]` regardless of part of speech), not the API itself —
  fixed by the multi-sense picker above. With that fixed, swapping sources isn't worth the
  effort right now. Revisit only if sense quality is still a complaint after using
  multi-sense for a while; Merriam-Webster stays reserved for if/when this goes fully public.
- **Open bug: magic-link sign-in fails for a second (non-owner) email**, `ERR_CONNECTION_RESET`
  in the browser right after clicking the link, on the live GitHub Pages site. Ruled out:
  the Redirect URLs config (has an exact, non-wildcard entry for the live origin) and
  `allowed_emails` (that email is already on it). Suspect network-layer, not app
  config — clicking a Supabase magic link hits Supabase's own `/auth/v1/verify` endpoint
  first, before ever reaching this app, so a reset there could be a firewall/antivirus on the
  other person's device/network, or their email client's link-scanning proxy, rather than
  anything wrong with this repo. **Deferred until the other person is around in person to
  test together** — no fix attempted yet, don't guess further without them present.

## Architecture (hold to these)
- **One file:** the whole app lives in `index.html` (HTML + CSS + JS inline), kept readable
  on purpose. Do not split into a build system or framework unless explicitly asked.
- **Plain vanilla JS.** No React, no bundler, no npm dependencies in the app itself. The one
  exception is Supabase JS, loaded via `<script src="...cdn.jsdelivr.net...">` — still no
  build step, so it fits the same spirit.
- **PWA:** `manifest.json` + `sw.js` make it installable. The service worker caches only the
  app shell, never dictionary/API responses. Known gap, bigger now than before: it doesn't
  cache the Supabase CDN script, and saved words now live entirely in Supabase (no local
  fallback since storage moved off IndexedDB) — opening the app fully offline will fail
  until Phase 2b addresses this. Not fixed yet, flagged for later.
- **Lookups:** the free dictionaryapi.dev API (no key) is still the default/Dictionary tab.
  The AI tab is Gemma 4 via Google's Gemini API, called through the Cloudflare Worker — see
  M4 in Current state above.

## Rules that protect future phases — do not break
1. **Wrap all persistence in a small storage module** (`saveEntry`, `getEntries`,
   `deleteEntry`). The UI must never touch the storage layer directly. This paid off exactly
   as planned: Phase 2 swapped these three functions from IndexedDB to Supabase and nothing
   else in the app had to change.
2. **Never hardcode or commit secrets/API keys.** When the LLM arrives (Phase 3), the key
   lives only in a serverless proxy's environment — never in this repo. **Exception, not a
   violation:** the Supabase anon/public key IS meant to be embedded client-side — it's
   public by design, and Row Level Security policies on the Supabase side (not the key) are
   what actually protect data. Don't treat it like the Anthropic key.
3. **Preserve the visual style:** warm paper ground (#FBF9F4), oxblood accent (#8A3033),
   Fraunces (serif, for the word/headword) + Inter (UI). Keep it calm and editorial.
4. Keep it accessible: visible keyboard focus, respect reduced-motion, responsive to mobile.

## Roadmap
- M2: save lookups to IndexedDB via the storage module; a saved list that loads on open,
  filters by book, and supports delete. DONE.
- M3: voice input (mic button, Web Speech API). DONE.
- **M4: DONE** — live via Gemma 4 (free tier), not Claude Haiku as originally planned. See
  Current state above for the full picture and `worker/README.md` for the deployed setup.
- M5: polish (offline-aware error message, install prompt, dark theme). DONE.
- **Phase 4: flashcards + quiz, scoped to the current book filter. DONE** (see Current state
  above for details). Client-side only — no auth needed, which is why this went ahead of
  Phase 2 back when Phase 2 hadn't started.
- **Phase 2 (cloud sync): DONE** — auth + storage both wired to Supabase (see Current state
  for details).
- **Phase 2b (not started):** offline caching / local-first sync, using the IndexedDB code
  that's been kept around unused for exactly this.

## Working style
Explain changes in plain terms — I'm learning. Prefer small, reviewable steps over large
rewrites. When unsure about a design or data decision, ask before implementing.

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
- M4's LLM proxy (`worker/`) and its frontend button are built and locally tested, but
  intentionally left off (`AI_ENABLED = false`) — activation is deferred until there's a
  revenue-backed plan for the ongoing API cost, since it's billed separately from any
  Claude.ai subscription.
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
  server-side by the project's disabled-signups setting). The old IndexedDB code is kept
  as `openDBLocal`/`saveEntryLocal`/`getEntriesLocal`/`deleteEntryLocal` — unused, not
  deleted, for a Phase 2b offline-caching pass. One known simplification: saving a word
  you've already saved no longer merges the book into the existing row (the old IndexedDB
  version did) — it's a plain insert, so the same word saved from two books now makes two
  rows. Revisit if that's missed in practice.
- Live and installed on Windows and Android; hosted via GitHub Pages. **Not yet pushed:**
  all of Phase 2 (auth + Supabase storage) is committed locally on `main` but not pushed —
  the live site still only has M0–M5 + Phase 4. See "Picking up next session" below.

## Picking up next session
- **Phase 2 code is written but not yet confirmed working end-to-end.** Signed in
  successfully once; saving a word after the storage rewrite hasn't been verified yet —
  testing got blocked by Supabase's email rate limit (see below) before that could happen.
- **Confirm the `entries` table exists** with the right columns + RLS policies — the SQL to
  create it (if not already run) is in the commit message for "Phase 2: wire storage to
  Supabase" (`git show --stat` / `git log` to find it), or ask Claude to regenerate it.
- **Pending decision: custom SMTP provider.** Supabase's default email sending is
  rate-limited hard (fine for testing, hit the limit today from repeated sign-in attempts).
  Two options discussed, not yet chosen: Gmail SMTP (free, uses the existing
  debashis9@gmail.com with an app password, simplest) vs. Resend (free tier ~3,000/month,
  more "correct" long-term, needs a new account + ideally a verified domain). Pick one,
  wire it up in Supabase → Authentication → Emails → SMTP Settings.
- **README.md needs trimming** — flagged as having too much information. Hold off on a
  rewrite until there's time to review what actually stays; don't do this unsupervised.
- **Nothing needs pushing to resume tomorrow** — everything is committed locally on `main`.
  Push whenever, there's no urgency; the live GitHub Pages site simply stays on the older
  (pre-Phase-2) commit until then.

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
- **Lookups:** currently the free dictionaryapi.dev API (no key). An LLM upgrade comes later.

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
- **M4: built but dormant.** A Cloudflare Worker proxy (`worker/`) calls Claude Haiku 4.5
  for a book-context-aware AI definition, and the frontend has a "Get AI definition"
  button — but it's feature-flagged off (`AI_ENABLED = false` in `index.html`) because
  the API key needs its own separate billing (not covered by a Claude.ai subscription).
  Decision: hold off until scaling to a wider audience with a revenue model in place, then
  flip the flag and deploy the Worker. See `worker/README.md` for activation steps.
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

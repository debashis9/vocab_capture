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
- **Phase 2 (cloud sync) — started: auth only.** Supabase JS v2 (CDN, no build step) gates
  the whole app behind email magic-link sign-in — signed out shows only a sign-in card,
  signed in shows the normal app plus an email + Sign out strip. `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` in `index.html` are placeholders until filled in with a real project.
  Storage is still local IndexedDB only — signing in doesn't sync anything yet, that's the
  next step.
- Live and installed on Windows and Android; hosted via GitHub Pages.

## Architecture (hold to these)
- **One file:** the whole app lives in `index.html` (HTML + CSS + JS inline), kept readable
  on purpose. Do not split into a build system or framework unless explicitly asked.
- **Plain vanilla JS.** No React, no bundler, no npm dependencies in the app itself. The one
  exception is Supabase JS, loaded via `<script src="...cdn.jsdelivr.net...">` — still no
  build step, so it fits the same spirit.
- **PWA:** `manifest.json` + `sw.js` make it installable. The service worker caches only the
  app shell, never dictionary/API responses. Known gap: it also doesn't cache the Supabase
  CDN script, so opening the (now auth-gated) app fully offline will fail until that's
  addressed — not fixed yet, flagged for later.
- **Lookups:** currently the free dictionaryapi.dev API (no key). An LLM upgrade comes later.

## Rules that protect future phases — do not break
1. **Wrap all persistence in a small storage module** (`saveEntry`, `getEntries`,
   `deleteEntry`). The UI must never touch the storage layer directly. This is what lets us
   swap local storage for a cloud database (Phase 2) without rewriting the UI. Not done yet —
   Phase 2 so far is auth only; `saveEntry`/`getEntries`/`deleteEntry` are still pure
   IndexedDB, not wired to Supabase.
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
- **Phase 2 (cloud sync): in progress.** Step 1, Supabase magic-link auth, is DONE (see
  Current state). Still to do: wire `saveEntry`/`getEntries`/`deleteEntry` to a Supabase
  table instead of IndexedDB (or sync between the two), scoped per signed-in user.

## Working style
Explain changes in plain terms — I'm learning. Prefer small, reviewable steps over large
rewrites. When unsure about a design or data decision, ask before implementing.

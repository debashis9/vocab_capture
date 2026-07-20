# CLAUDE.md — Margin

## What this is
Margin is a personal vocabulary-capture app: catch an unknown word while reading a
physical book, look it up, and keep it — tagged to the book. Single-user, personal tool.

## Current state
- Milestones M0 (installable PWA) and M1 (typed lookup) are DONE.
- Live and installed on Windows and Android; hosted via GitHub Pages.

## Architecture (hold to these)
- **One file:** the whole app lives in `index.html` (HTML + CSS + JS inline), kept readable
  on purpose. Do not split into a build system or framework unless explicitly asked.
- **Plain vanilla JS.** No React, no bundler, no npm dependencies in the app itself.
- **PWA:** `manifest.json` + `sw.js` make it installable. The service worker caches only the
  app shell, never dictionary/API responses.
- **Lookups:** currently the free dictionaryapi.dev API (no key). An LLM upgrade comes later.

## Rules that protect future phases — do not break
1. **Wrap all persistence in a small storage module** (`saveEntry`, `getEntries`,
   `deleteEntry`). The UI must never touch the storage layer directly. This is what lets us
   swap local storage for a cloud database (Phase 2) without rewriting the UI.
2. **Never hardcode or commit secrets/API keys.** When the LLM arrives (Phase 3), the key
   lives only in a serverless proxy's environment — never in this repo.
3. **Preserve the visual style:** warm paper ground (#FBF9F4), oxblood accent (#8A3033),
   Fraunces (serif, for the word/headword) + Inter (UI). Keep it calm and editorial.
4. Keep it accessible: visible keyboard focus, respect reduced-motion, responsive to mobile.

## Roadmap
- **M2 (next):** save lookups to IndexedDB via the storage module; a saved list that loads on
  open, filters by book, and supports delete. Add a "Save to list" button on a successful lookup.
  Entry fields: id, word, meaning, partOfSpeech, synonyms, antonyms, example, book,
  source ("typed"), savedAt.
- M3: voice input (mic button, Web Speech API).
- M4: optional LLM-upgraded definitions (needs API + serverless proxy).
- M5: polish (offline queueing, install prompts, theming).

## Working style
Explain changes in plain terms — I'm learning. Prefer small, reviewable steps over large
rewrites. When unsure about a design or data decision, ask before implementing.

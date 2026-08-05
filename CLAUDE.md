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
- **The Worker requires a live Supabase session — no open endpoint.** Both `/define-gemma`
  and `/define` (and any unrecognized path) reject with 401 unless the request carries a real
  `Authorization: Bearer <supabase-access-token>`, verified by calling Supabase's own
  `/auth/v1/user` endpoint (`verifySupabaseAuth()` — deliberately not reimplementing JWT
  signature checking in the Worker). This was added after finding the endpoint had no auth
  check at all — a bare curl returned a real definition, meaning anyone with the URL
  (published in `index.html`'s public source) could spend Gemini quota. Not a cost risk today
  since Gemma's free tier has no paid tier and the Claude key is unfunded, but a real
  availability risk (`*.workers.dev` subdomains do get hit by automated scanners) and would
  become a real cost risk the moment either backing key is ever paid. `index.html`'s
  `lookupAI()` sends `currentSession.access_token` as the bearer token. Also fixed in the
  same pass: unrecognized paths used to silently fall through to the (unfunded) Claude
  path instead of 404ing, which is what turned a plain wrong-URL curl test into a confusing
  "could not resolve authentication method" Anthropic SDK error.
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
  `main` (last pushed 2026-07-24, includes M4/Gemma, the Worker auth requirement, and the
  `sw.js` v17 bump — remember to hard-refresh/unregister-and-reload an already-installed copy
  to actually see it, per the PWA note above). SMTP: Gmail (debashis9@gmail.com + a Google
  App Password), not Resend — Resend needs a verified domain to email anyone but the signup
  address itself, and buying one solely to unblock it wasn't worth it for a
  personal/family-tester app.
- **Custom sign-in email template is DONE, live as of 2026-07-31.** Supabase's default
  magic-link email (generic, no branding) is replaced by `supabase/email-templates/magic-link.html`
  — a tracked copy of what's pasted into Supabase → Authentication → Emails → Templates →
  Magic Link (dashboard is the source of truth; keep both in sync if either changes). Plain
  table layout with inline styles and web-safe font fallbacks (Georgia/system sans), not
  Fraunces/Inter, since email clients strip `<style>` blocks and block custom web fonts.
  Links out to `guide.html` (already public at the GitHub Pages origin) for first-time
  recipients instead of attaching it — Supabase's template editor has no attachment
  mechanism at all, even with custom SMTP wired in, since GoTrue renders and sends the email
  itself. Only the Magic Link template was redone at the time (not "Invite user") since the
  invite flow then was dashboard "Add user" → the person requests their own magic link, never
  Supabase's separate invite email. **That reasoning expired on 2026-08-05**, when
  `approve-access` started calling `inviteUserByEmail` — so there is now a second template,
  `supabase/email-templates/invite.html`, same table layout and web-safe fonts, written for a
  first arrival rather than a returning sign-in: it says who added them, gives `guide.html`
  real weight instead of a footnote, and tells them what to do if the one-time link has
  expired (their account exists by then, so the normal "Send me a link" box works). Uses
  `{{ .ConfirmationURL }}` and `{{ .Email }}`; subject "You're in — welcome to Margin". Same
  caveat as its sibling: **the dashboard is the source of truth**, this file is a tracked copy,
  and it is NOT live until it's pasted into Authentication → Emails → Templates → Invite user.
- **Debugged 2026-07-31: a stale localhost-bound home-screen icon, not a real bug.** A report
  of "can't sign in from the saved app icon on Android" traced to `index.html`'s
  `emailRedirectTo: window.location.origin + window.location.pathname` (deliberately dynamic,
  so local dev and prod both work without hardcoding either) — the icon in question was an
  old install pointed at `http://localhost:8000` from earlier local testing, so every magic
  link it generated pointed back at a local dev server that wasn't running, producing a
  connection error on the phone. Fixed by removing that icon and reinstalling fresh from the
  real GitHub Pages URL; no code change. **A second, more consequential leftover was found in
  the same pass:** Supabase's own Site URL setting (Authentication → URL Configuration) — the
  fallback used whenever `emailRedirectTo` doesn't exactly match an entry in the Redirect
  URLs allow list — was still `http://localhost:8080` from local dev. Since the allow list
  only ever had the one real entry (`https://debashis9.github.io/vocab_capture/`), *any*
  sign-in whose computed origin+path didn't match it exactly would have silently fallen back
  to that dead localhost address — a risk for any tester, not just this device. Fixed
  2026-07-31 by setting Site URL to `https://debashis9.github.io/vocab_capture/` to match the
  allow list.
- **A dictionary miss is no longer a dead end, done 2026-07-31.** Previously, a 404 from
  dictionaryapi.dev (or any lookup failure) just printed a plain error string — `render()`
  was never called, so no card and no Dictionary/AI toggle ever appeared, meaning the AI tab
  was unreachable for exactly the words that needed it most. `lookup()` now calls a new
  `renderNotFound(word, message)` on any failure, which builds a `{ notFound: true,
  notFoundMessage }` stub and reuses the normal `render()`/`renderCard()` path — the card and
  toggle show up as usual, `renderDictionaryBody()` shows the not-found message (no bogus
  "Save to list" button) instead of a definition, and the AI tab sits one tap away in its
  normal not-yet-fetched state. AI still isn't auto-fetched on a miss — stays opt-in, same as
  a successful lookup, so a typo doesn't silently spend Gemini quota. Also made the AI tab's
  own error message offline-aware (`fetchAI()`), matching the dictionary tab's existing
  `navigator.onLine` check, for consistency.
- **Private `#admin` route for the invite allowlist, done and live-verified 2026-07-31.** Not
  linked from anywhere in the normal UI. Real access control is RLS policies on
  `allowed_emails` (`supabase/sql/admin-allowed-emails-rls.sql` for select/insert/delete,
  `admin-allowed-emails-soft-delete.sql` adds update) that hardcode the admin account's
  `auth.uid()` — the client-side "Not authorized" check in `checkAdminRoute()` is only a clean
  experience for anyone who stumbles onto the hash, not the actual boundary; a non-admin's
  Supabase queries come back empty (or get rejected) regardless of what the UI decides.
  Deliberately independent of the main auth section — its own `onAuthStateChange` subscription
  and `getSession()` call, so nothing in sign-in/sign-out changed.
  **Soft-delete, added same day:** "Delete" sets `deleted_at` instead of removing the row —
  removed emails stay visible, greyed out and struck through, sorted to the bottom, each row
  showing serial number plus added/deleted timestamps. Re-adding a previously-deleted email
  revives it (`.upsert(..., { onConflict: "email" })`, clearing `deleted_at` while keeping the
  original `added_at`). Critically, `check_allowed_email()` (the `before insert on auth.users`
  trigger) was patched in the same pass to add `and deleted_at is null` to its existence
  check — without that, a soft-deleted email would still be able to sign in, making "Delete"
  cosmetic rather than a real revocation. Confirmed live end-to-end by debashis9: soft-delete
  UI renders correctly against the real table, and both directions of the trigger fix
  (deleted email blocked, revived email works again) check out.
- **Update-available banner, done and live-verified 2026-07-31.** `sw.js` already calls
  `skipWaiting()` + `clients.claim()` on every install/activate, so a new version takes over in
  the background automatically — but a page already open in memory doesn't hot-swap its own JS
  just because a new worker took control. Listens for `navigator.serviceWorker`'s
  `controllerchange` event and shows a small sticky banner with a Refresh button. For ordinary
  users this is a nice-to-have, not a fix for a real problem — normal update propagation (next
  app open, no manual steps) already works; this just makes an otherwise-silent moment visible.
  Verified structurally (synthetic `controllerchange` event) and then for real — debashis9 saw
  it fire after a relogin, correctly reporting v20 before the v21 push and again once v21
  actually landed. **Correction, 2026-08-02: the original claim here that this "fires only on a
  real update, never on first-ever install" was wrong** — `clients.claim()` fires
  `controllerchange` the first time a page becomes controlled too, not just on a genuine
  version change, so the banner was flashing on any fresh install/unregister-and-reload (found
  via a headless test with zero prior service worker state, where it fired immediately). Fixed
  by tracking whether the page already had a controller at load time and only surfacing the
  banner if it did — a page with no controller yet is a first install, not a real update.

- **A batch of smaller fixes and features, all committed to `main` on 2026-08-02, not yet
  confirmed pushed past the 2026-07-24 deploy noted above** — bump `sw.js` and hard-refresh to
  see any of these once they do go out:
  - **Admin panel: the signed-in admin's own row now shows an `(admin)` badge instead of a
    Delete button**, so the admin invite-list UI can't be used to lock yourself out of your own
    list. Purely a UI guard — RLS still doesn't stop a raw API call from deleting your own row,
    same as every other client-side check in this admin route.
  - **The SW shell-cache staleness bug, found because of the above**: bumping `sw.js`'s `CACHE`
    string alone doesn't guarantee fresh bytes, since `caches.addAll(SHELL)` fetches normally and
    can pull a stale HTTP-cached `index.html` into a brand-new, correctly-named bucket. This is
    why the admin badge didn't show up live under `v22` even though that cache was confirmed
    active. Fixed by fetching each shell file with `{cache: "reload"}` during install, forcing a
    real network hit regardless of the browser's own HTTP cache.
  - **Saved words can be marked "mastered"** (a timestamp, same soft-flag shape as
    `allowed_emails.deleted_at`) — greyed out with a badge, automatically excluded from
    flashcards/quiz (practice should only surface words still being learned), not from the
    saved list itself. Needed `supabase/sql/entries-context-and-mastered.sql` (additive columns,
    no RLS changes — `entries`'s existing policies already scope everything to `auth.uid()`).
  - **An optional "Sentence" field** captures the actual line from the book where a word was
    found (distinct from `example`, the dictionary/AI's own generic sentence) — same migration
    as above (`context_sentence` column), shown in the saved list and on flashcards, cleared
    after each save since it's per-word, unlike "Reading."
  - **Auto-search**: the dictionary tab fires ~500ms after the last keystroke instead of
    requiring Enter/"Look up" — the closest thing to real-time this is capable of, since
    dictionaryapi.dev has no prefix/autocomplete endpoint. Added a sequence-number guard in
    `lookup()` so a slow response for an earlier, still-being-typed word can't land after and
    overwrite a faster response for what was typed next.
  - **The result card resets to the idle prompt ~700ms after a successful save** (word field
    cleared, focus returned) instead of just sitting there — "Reading" is left untouched since
    it persists across several words from the same book.
  - **Preconnect hints** for the dictionary API, the AI Worker, and Supabase, so the first
    request of a session isn't also paying DNS/TLS handshake cost on top of the real round trip.

- **Offline mode (built 2026-08-02 on `future/ocr-offline-library`, since merged to `main`).** The saved list and flashcards/quiz now fall back to
  a local IndexedDB mirror (`saveEntriesMirror`, refreshed on every successful *unfiltered*
  Supabase read — a filtered, single-book read deliberately does NOT refresh it, or it would
  wipe out every other book's cached entries the next time someone has a book filter selected)
  when the live read fails, addressing the "can't open at all without a connection" gap noted
  under Architecture below. Also adds an offline capture queue: saving a word you can't
  currently look up (because you're offline, not because it's a confirmed 404) queues it
  locally via a new "Save for later" button — shown only on the network-failure path in
  `renderNotFound`, never on a genuine miss. Queued words are looked up and saved for real
  (`source: "queued"`) automatically once back online (`processPendingQueue`, triggered by a
  `window` "online" listener and a check in `showSignedIn`); a capture that turns out to be a
  genuine miss shows a "Not found" badge with Retry/Delete instead of vanishing. The Supabase
  SDK is now pinned to an exact version (`@2.111.0`, was a floating `@2` tag) and cached by the
  service worker, so the app shell itself — not just saved data — can load with no network;
  previously not even an already-signed-in session could initialize offline at all. **Known,
  accepted limitation:** only rides out a dead zone within a session that started online, since
  Supabase access tokens need network to refresh once expired (~1hr default) — not fixable in
  app code. **One real bug found via the user's own live testing** (not caught by automated
  testing, which uses Playwright's own reliable offline emulation): the local-mirror fallback
  was gated on `navigator.onLine`, which turned out to report `true` in at least one real
  browser/OS combination even though the live read had genuinely failed — fixed by falling back
  on any live-read failure, unconditionally, rather than trusting that flag.

- **OCR camera-capture, on the `future/ocr-offline-library` branch — DONE and verified live as
  of 2026-08-04** (see the dated entries further below for the full path from first prototype to
  verified). Point a camera at (or upload a photo of) a page; a new Worker
  endpoint (`/ocr`, same `verifySupabaseAuth`/CORS pattern as `/define-gemma`) sends the image
  to Gemma 4 26B — the same model as the AI tab (confirmed via a real test call that it
  genuinely accepts image input, description matched the actual test image) — and asks for a
  bounding box per distinct word (Gemini's documented normalized `[ymin,xmin,ymax,xmax]`,
  0-1000 scale). Chosen over a client-side OCR library (e.g. Tesseract.js) specifically to
  avoid a second CDN dependency beyond the one exception (Supabase JS) the architecture rule
  below allows, and because multimodal models handle real, messy photos better than Tesseract
  in practice. The client renders the captured photo with a transparent tappable button over
  every word, positioned as a percentage of the image (no pixel math needed, the boxes are
  already normalized); tapping one calls `lookup()` directly rather than waiting for the
  auto-search debounce, since tapping a specific word is a far more deliberate action than a
  typing pause — checked directly that the mic button's own flow does NOT actually auto-trigger
  a lookup this way, so this was a deliberate divergence from that precedent, not a copy of it.
  Double-tap toggles ~2x zoom (centered on the tap point) since a real page has far more words
  than comfortably fit as tap targets on a phone screen — deliberately not full continuous
  pinch-gesture tracking, chosen as the simpler of two real options since there's no existing
  touch-gesture code in this app to build on. Both a live `getUserMedia` preview and a plain
  "Choose a photo" file picker are offered, converging into one shared
  `processCapturedImage()` pipeline.
  Three real bugs found via live testing with an actual photographed book page (not caught by
  synthetic test images, which were too short/simple to trigger any of these): (1) the Gemini
  response's "thinking" part (still present even at `thinkingLevel: "minimal"`) was being read
  instead of the real answer — `lookupOcr` was missing the same `!part.thought` filter
  `lookupGemma`'s streaming parser already needed; (2) `maxOutputTokens: 4096` was too tight for
  a real, dense page (a 147-word test page alone used ~4300 output tokens) — bumped to 12000;
  (3) a trailing comma on a recognized word (e.g. `"fences,"`) broke the Dictionary tab's
  exact-match lookup even though the AI tab tolerated it fine — the OCR prompt now asks for
  punctuation-stripped text, and the Worker strips it defensively too regardless of whether the
  model complies.
  **Real-device test, 2026-08-02/03: the "blocky rectangle" report was a false alarm, not a
  bug.** debashis9 photographed a real page ("Drink of the Gods", p.139) with an Android phone
  and uploaded it via desktop Chrome's "Choose a photo" (USB live-camera debugging was attempted
  first but abandoned over permission concerns — see below); the overlay appeared to be one
  dark rectangle instead of one box per word. Checking the actual `/ocr` response showed Gemini
  had correctly returned ~135 individual, correctly-ordered, correctly-boxed words spanning the
  whole visible paragraph — the "one box" was just whichever `.ocr-word-choice` button currently
  had `:hover`/`:focus-visible` (the only state at which these deliberately-transparent buttons
  show any color at all), not a rendering or model bug. Confirms the core OCR recognition
  genuinely works on a real, imperfect, handheld photo (angle, blur, page curl included).
  **One real bug found and fixed in the same pass, 2026-08-03:** re-submitting that same photo
  twice afterward both failed with `SyntaxError: Expected ',' or ']' after array element` — this
  page's dialogue is quote-heavy (`"I will take you around after lunch," said Brahaspati...`),
  and Gemini doesn't always comply with the prompt's instruction to strip quote marks out of a
  word's `text` field first, so an unescaped `"` sometimes lands inside a JSON string and breaks
  parsing. Live-tested as genuinely transient sampling variance (same photo, same code, worked
  on the very next call) — this is what motivated the streaming rework below, which sidesteps
  the failure mode entirely rather than papering over it with a retry.
  **Cloudflare Worker timeout ceiling, confirmed 2026-08-03 (corrects the entry above):** per
  Cloudflare's own docs, an HTTP-triggered Worker has **no fixed wall-clock duration limit** as
  long as the client stays connected — the actual cap is *CPU time* (30s default on Paid, up to
  5 min configurable), and time spent awaiting `fetch()` (e.g. the whole Gemini call) does not
  count against it at all. So a slow OCR call was never at real risk of Cloudflare cutting it
  off; the real cost of a 60-90s wait was purely UX (and a smaller risk of a mobile
  network/carrier dropping an idle-looking long connection), not an imminent timeout.
  **Crop-before-send + streaming word list, done 2026-08-03 — the fix for both the latency and
  the "waits a minute then dumps everything at once" UX.** Two changes, made together:
  (1) A new crop-selection screen (`renderCropChooser`/`wireCropSelection` in `index.html`) sits
  between capture and send: drag over a paragraph or a few lines (percent-of-viewport
  coordinates, same idiom the word-overlay itself already used), then "Scan selected area" or
  "Scan whole photo". Crucially, the crop is taken from the *original* working canvas
  (`CROP_SOURCE_MAX_DIMENSION = 2400`) rather than a copy already downscaled for the old
  whole-page flow — `OCR_MAX_DIMENSION` (1600) now caps only the final, already-cropped region,
  so a small selection keeps far more real detail per word than before, not less. Fewer output
  tokens needed for a small region is also the main latency lever, directly addressing the
  ~60-90s full-page wait.
  (2) The Worker's `/ocr` no longer waits for one full response then does a single
  `JSON.parse()` — it uses `streamGenerateContent` (same pattern as `lookupGemma`) and
  incrementally regex-extracts each complete `{"text":..., "box":[...]}` entry from the
  accumulating text as Gemini generates it, forwarding each as its own SSE event the moment it's
  complete. The client (`streamOcrWords`/`appendOcrWordButton`) reads this and appends each
  word's tappable button to the photo as it arrives, instead of waiting for the whole list.
  This also happens to make the quote-escaping bug above moot rather than patched: a corrupted
  entry simply never forms a complete regex match and is silently skipped, instead of a single
  bad character invalidating the entire response the way whole-response `JSON.parse` did — so
  the retry-once wrapper built for that bug was removed as superseded, not kept alongside.
  Neither `maxOutputTokens` nor the model changed — this is a delivery-timing change, not an
  accuracy one.
  **Verification performed 2026-08-03 (honest about scope — no real phone/photo access from
  here):** the Worker's actual Gemini-facing streaming+regex logic was run for real (via the
  local `.dev.vars` Gemini key, bypassing only the Worker's HTTP/auth layer, which is unrelated
  to this change) against a small cropped test region and correctly recognized 5 words in ~5.8s
  total (~4s to the first word) — confirms the mechanism itself works end-to-end. The
  whole-page version of that same synthetic test image produced a bad, repetitive result (93s,
  only 7 words) — a pre-existing quirk of that particular synthetic test asset, not a regression
  from this change, and not a reliable stand-in for the real "before" baseline, which remains
  debashis9's own earlier live test (~90s-1.7min for a full real photo, all ~135 words correct).
  The client-side crop-drag → confirm → incremental-word-rendering flow was verified end-to-end
  in a headless browser against the real `index.html` code (mocked only the `/ocr` network
  response, since a real call needs a live Supabase session not available here) — box math and
  percent positioning confirmed correct.
  **The real hands-on test happened 2026-08-04 and passed — "Everything checks out. Looks
  clean," confirmed live by debashis9** (desktop + "Choose a photo", not yet a real Android
  phone — see below). Testing on a real Android phone is still open — USB live-camera debugging
  was attempted the prior session but paused over permission-comfort concerns, not a technical
  blocker; "Choose a photo" with a phone-taken picture remains a fully valid way to test OCR
  recognition/accuracy/crop/streaming without it, and is a reasonable default going forward
  unless the live-camera-specific UX (getUserMedia permission prompt, viewfinder) is
  specifically what needs testing.
  **A round of real bugs found via that hands-on test, all fixed same day (2026-08-04):**
  (1) The crop-selection drag had no stopping rule — starting a drag on the photo triggered the
  browser's own native "drag this image" gesture, which hijacked the pointer sequence so
  `pointerup` never fired, leaving the selection box tracking the cursor indefinitely with no
  way to stop it. Fixed with `-webkit-user-drag: none`/`user-select: none` on the crop image,
  `draggable="false"`, `e.preventDefault()` on pointerdown, and a `pointercancel` safety net —
  verified with a real-mouse-event test that reproduced the exact symptom before the fix and
  confirmed a clean stop after.
  (2) Tapping a word early in a long stream (e.g. "time", a handful of words into a ~135-word
  page) abandoned the rest of the stream with no way back to the photo, and — separately — a
  dictionary lookup for that same word then failed ("Couldn't reach the dictionary"), most
  likely from the still-running background stream competing for the browser's
  network/CPU right as the dictionary fetch went out (not fully reproduced in isolation, so
  flag it again if it recurs). Fixed by a real redesign, not a patch: tapping a word now
  *pauses* the scan (`pauseCameraSection()`) instead of closing it — the same photo and
  whatever words had streamed in are still there if the scan button (now showing a small dot)
  is tapped again, verified to resume without re-fetching. Only a genuine close (×) actually
  cancels the in-flight stream, via a real `AbortController` wired through `streamOcrWords()`,
  so background token/time is no longer spent on words nobody will see once someone's done.
  **Two other fixes from the same pass, unrelated to OCR:** the frontend-design pass's
  signature mark (the squiggle beside the wordmark, and the underline-reveal under a looked-up
  word) was removed entirely per feedback ("not liking it at all... clean UI") — debashis9 may
  revisit a quieter mark later (a corner-fold glyph or a single hand-drawn tick were floated as
  options, not built). Copy changed for clarity: "Save this sense" → **"Save this meaning"**
  (hint text updated to match: "N meanings found..."), and "Master it"/"Mastered" →
  **"Learned it"/"Learned"** (the original read as the app commanding the user to go master a
  word they'd just looked up, rather than a self-assessment flag) — both chosen by debashis9
  from a few options rather than picked unilaterally.

- **Book scanning / library, built 2026-08-04, on `future/ocr-offline-library` — the last of
  the three features parked on this branch from the 2026-08-02 competitor research** (OCR and
  offline mode were the other two, both already done). Scan a book's back cover or barcode
  area; a new Worker endpoint (`/book-lookup`, same `verifySupabaseAuth`/CORS pattern as every
  other route) reads the printed ISBN, title, and author with the same Gemini vision model
  already used for OCR (`OCR_MODEL`) — deliberately **not** a client-side barcode-decoding
  library, for the same reason Gemini was picked over Tesseract.js for OCR: no second CDN
  dependency (Supabase JS stays the one exception), and a book's ISBN digits are always printed
  as human-readable text right next to the barcode, so a photo is enough. Unlike `/ocr`, this
  is a single non-streaming call (`lookupBookCover`, following `/define-gemma`'s shape) — one
  small result, not a growing word list, so there's no reason for SSE here.
  **Purely additive, no migration risk:** `entries.book` is untouched — still plain text, still
  the same exact-match filter (`populateBookFilter`). A new `books` table
  (`supabase/sql/books-table.sql` — **run in the Supabase SQL editor on 2026-08-04**, same as
  every other `supabase/sql/*.sql` file in this repo; not something I can run myself) is a convenience layer on top: RLS scoped to
  `auth.uid() = user_id` (the same per-row-ownership shape `entries` already uses, not
  `allowed_emails`' hardcoded-admin shape, which is the wrong model for a personal list),
  `unique(user_id, isbn)` so re-scanning a book upserts instead of duplicating (manual entries
  with no isbn always insert fresh — Postgres treats multiple NULLs as distinct for a unique
  constraint). Cover art needs no API call at all —
  `https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg` is a bare, keyless image URL, with an
  `onerror` fallback to a placeholder for missing-isbn or no-cover-on-file books.
  New "Library" button next to Practice opens a dedicated screen (books listed with cover
  thumbnail/title/author/date, tap one to fill the "Reading" field, Delete per row — a plain
  hard delete, not soft-deleted like `allowed_emails`, since this isn't an audited security
  boundary) plus an "Add a book" flow (take/choose photo, `/book-lookup`, confirm, or "Enter it
  manually instead" as a safety net for glare/damaged-cover misses, same never-a-dead-end
  spirit as the dictionary tab's not-found handling). **Deliberately a separate, small
  implementation from the OCR camera flow**, not sharing its crop/streaming/pause-resume state
  machine — that exists specifically for "tap a word from a growing list," which doesn't apply
  to a single-shot book lookup; only the generic chooser/live-preview/downscale shape is
  mirrored, not literally shared code. If a third capture flow ever shows up, that's the
  trigger to factor out a shared helper, not before.
  **Verified:** the real Gemini call against a synthetic test cover (title, author, and a
  hyphenated ISBN all correctly extracted and cleaned to digits-only, roughly a 3.8-second round
  trip); the full client flow end-to-end in a headless browser with mocked `/book-lookup` and
  Supabase REST calls (empty state, scan through to confirm, appears with cover, tap-to-select
  fills "Reading", delete, manual-entry fallback, and the cover-image-404 placeholder fallback)
  — zero console errors, and a full regression pass confirmed the existing
  saved-list/book-filter/lookup flow is untouched. **Fully verified live 2026-08-04 by
  debashis9:** the migration is run, scanning a real physical book's cover added it correctly,
  and the Library screen lists books properly against the real table. Nothing about this feature
  is outstanding.

- **A mobile-usability round, 2026-08-04, from debashis9's first real phone test of the merged
  app** (everything above is now on `main` and pushed — the `future/ocr-offline-library` branch
  still exists but `main` is the live one). All five were found by using it on a phone, none by
  automated testing, which had only ever measured desktop-width layouts:
  - **The crop screen's "Scan selected area"/"Scan whole photo" buttons sat below the fold**, and
    the only way to scroll down to them was dragging a finger across the photo — which starts a
    new selection and wipes the one just drawn, so you could never actually reach the buttons
    with a selection intact. Three changes together: the buttons are now a `position: sticky;
    bottom: 0` bar (`.crop-actions`) so they're always on screen; `renderCropChooser()` and
    `openCameraSection()` scroll the scan UI to the top of the viewport (it's the last section on
    the page, so it opened below the fold); and on ≤520px the photo is capped at 50vh with
    tighter section margins, so header + tip + photo + buttons all fit a 390×780 screen at once.
  - **A stray tap on the photo no longer clears an existing crop selection** — `wireCropSelection`
    keeps the committed selection and redraws it (`showCommittedSelection()`) when a drag turns
    out to be a tap or under the 3% minimum, instead of dropping it.
  - **The library quick-pick `<select>` overflowed the screen.** A `<select>` sizes itself to its
    widest `<option>`, so one long book title stretched it past the right edge (the page scrolled
    sideways) and squeezed the "Reading" input next to it down to nothing — which is why a picked
    book looked like it "wasn't reflected" anywhere: it *was* filled in, into a field a few pixels
    wide. Now `.book-filter` is capped (`max-width: 150px`, ellipsized label) and the Reading
    row's copy is a fixed 104px; on ≤520px the Reading row wraps so the label + dropdown share
    line one and the text input gets the whole of line two. Same cap fixes the saved-list book
    filter, which had the identical problem. Option label shortened "From library…" → "Library…".
  - **The lookup row wrapped too**: on a 390px screen the word field, mic, scan and "Look up" all
    sharing one line left the field itself ~119px (about five characters). The field now takes
    the full line with the three buttons below it, `min-height: 46px` so they stay real touch
    targets once they no longer stretch to the field's height.
  - **The OCR word highlight no longer covers the word.** It used to fill the whole word box with
    opaque `--oxblood-soft` on hover/focus, hiding the exact thing you're trying to read (worse on
    a curved page, where you need the neighbouring letters to be sure you tapped the right word) —
    and since a phone has no hover, nothing marked which words were even tappable. Now: a
    pen-like underline at rest on every recognized word, a *translucent* wash (rgba, never a solid
    fill) on press/hover/focus, a branded `-webkit-tap-highlight-color` instead of Chrome's grey
    box, and a `.looked-up` class that keeps a word marked after you tap it, so returning to the
    paused photo shows what's already been looked up. Colours are hardcoded rgba rather than theme
    variables on purpose — the backdrop here is always the photo, not the app background.
  - **Streaming words now report progress.** The overlay shows a live "Reading the page… N words
    so far" line (pulsing dot) that switches to a green-dot "N words found — tap one to look it
    up" when the stream ends, and each word flashes briefly (`.just-arrived`) as it lands, so
    progress is visible on the photo itself. Previously a long scan gave no sign it was still
    working — the only way to tell was to tap something and see.
  - Also fixed in passing: `cameraToggleTargets()`/`practiceToggleTargets()`/`libraryToggleTargets()`
    used `querySelector(".book-row")`, which only ever hid the *first* row — so the "Sentence"
    field stayed visible behind the scan/practice/library screens. Now `querySelectorAll`.
  - Verified in a headless Chromium at a 390×780 mobile viewport against the real `index.html`
    (Supabase stubbed): no horizontal overflow, both dropdowns inside the screen, crop buttons
    on screen without scrolling, a drag-then-tap keeping its selection, the resting word marker
    having no fill, the progress line counting up and reaching its done state, and a tapped word
    staying marked. **Confirmed on a real phone by debashis9, 2026-08-04** — the fixes hold up
    in use; the word marking is readable against real paper.

- **A declutter round, 2026-08-04 (branch `design/declutter-ui`, merged to `main`)**, prompted by
  "the UI is too crowded". The signed-in page put five controls and four blocks of standing text
  between opening the app and typing a word; the word field started ~460px down a 844px phone
  screen. What moved:
  - **Masthead:** Sign out joined the theme toggle in the corner (it lives outside `#app-content`
    now, so `showSignedIn`/`showSignedOut` toggle it explicitly); the account strip and the
    signed-in email are gone. Shorter tagline, and a dog-eared page-corner glyph beside the
    wordmark — the "corner-fold" option floated back on 2026-08-04 when the earlier squiggle mark
    was cut. Chosen from five candidates rendered side by side; an outline-only page icon read as
    a generic "document" until the fold triangle got a filled `--paper-2` page behind it.
  - **Capture order:** the lookup bar is first on the page; "Reading" follows it as one bookplate
    line. The "Sentence" field moved *into* the result card as a collapsed "+ Add the line from
    your book" link — you only have a line to quote once you have a word. It sits outside
    `#tab-body` so a Dictionary/AI switch doesn't wipe it, and `sentenceDraft`/`sentenceOpen`
    mirror it so a full `renderCard()` doesn't either. All four save paths read it through
    `contextSentenceValue()`/`clearContextSentence()` (null-safe — the input only exists while a
    card is on screen).
  - **Saved list folded away** behind the "Saved words" heading, with a count; open/closed
    remembered in `localStorage` (`margin.savedOpen`), default closed. The book filter lives
    inside the opened panel. "Learned it"/"Delete" moved into the opened word's detail instead of
    repeating on every row — they were the densest thing on the page and squeezed the book·date
    line into wrapping.
  - **The Library button beside "Saved words" is gone.** "Add a book…" is now the second option
    in the Reading row's library dropdown (which is therefore never hidden any more, or a new
    account with no books could never reach the Library screen). Practice is untouched.
  - **One filled accent per screen:** `.btn-practice` and `.btn-save-sense` are neutral until
    hover/focus. A multi-sense word used to stack three outlined-oxblood "Save this meaning"
    pills down one card. The standing footnote moved to the sign-in card (`.auth-note`), where
    it's actually news.
  - **Two real Library bugs fixed on the way, both live since the feature shipped:** `.book-select`
    is a `<button>`, so it inherited the global `button { color: var(--on-oxblood) }` and painted
    book titles near-white on the near-white page — **invisible in light mode** (dark mode hid the
    bug, since `--on-oxblood` stays light); and it wasn't `display:flex`, so the cover thumbnail
    broke onto its own line above the title. Found by probing the rendered DOM, not by reading the
    CSS — the screenshot just looked like the title was missing.
  - Practice/Scan/Library used to open under an empty bordered band (their own `border-top` +
    margin framed nothing once everything above them was hidden). Fixed with a sibling selector,
    `.lookup[hidden] ~ .practice-section` etc., rather than more open/close bookkeeping in JS.
  - Verified headless at 390×844 against the real `index.html` (Supabase stubbed): 32 checks
    covering toggle persistence across a reload, row actions only inside the opened detail, the
    sentence surviving a tab switch and reaching the insert payload, both dropdown routes, every
    open/close pair, the two Library bugs, and no horizontal overflow. Note for future harnesses:
    the context needs `serviceWorkers: "block"`, or on the second load `sw.js` serves its cached
    copy of the Supabase SDK and the route-based stub silently stops applying.

- **Self-serve onboarding: an access-request queue, built 2026-08-05 on branch
  `onboarding-approval-flow`. Code complete, database and Edge Function live, and VERIFIED END
  TO END on 2026-08-05** against `localhost:8000` with `debashis9389@gmail.com`: request
  captured → queue → Approve → `auth.users` row created → branded invite delivered. The only
  surprise was where it landed — see the spam note below. This closes a gap that had been there since the invite list
  was built: `allowed_emails` is *not* a login list, it's a permission check the
  `before insert on auth.users` trigger consults **at the moment an account is created**.
  Adding an email on `#admin` therefore granted permission for an account that nothing in the
  app could create — `signInWithOtp` uses `shouldCreateUser: false`, so the person still got
  nothing until "Add user" was done by hand in the Supabase dashboard. Confirmed live against
  the real database on 2026-08-05: an email not on the list is blocked with "signup rejected",
  the same email succeeds once the list entry exists first, and a soft-deleted entry is blocked
  again. That ordering is load-bearing, and it's why approving happens where it does.
  - **The stranger's side.** The sign-in card has a second mode. A failed sign-in that looks
    like "no such account" (`otp_disabled` and friends — matched on error code first, wording
    only as a fallback) hands them to a request form with the email they already typed, asking
    for a name and an optional "how do we know each other?". A permanently visible "New here?
    Ask for access" link does the same thing, deliberately, so the flow doesn't depend on
    Supabase never rewording an error string.
  - **`public.access_requests` + `request_access()`** (`supabase/sql/access-requests.sql`,
    applied 2026-08-05). The table has admin-only select/update policies and **no insert policy
    at all** — the only write path is the SECURITY DEFINER function, which normalizes the
    email, validates it, collapses repeat asks into one row with a `request_count`, and caps
    new rows at 20/hour. Verified as the `anon` role: writes land, and `select count(*)` on the
    same table comes back 0. **A vibesec pass on 2026-08-05 tightened three things in it**, all
    re-verified live: the email pattern is now a character allowlist rather than
    "anything without an @ or a space" (so `<`, `>` and quotes can't reach the column at all —
    belt and braces, since the admin page escapes all three fields on render anyway); length
    caps of 254/80/280 on email/name/note, mirrored as `maxlength` on the form, because an
    anon-callable function with no ceiling lets one caller park megabytes in the table; and the
    repeat path now bumps at most once a minute, since the 20/hour limit only ever counted
    *new* rows and left repeat asks as an unmetered write. The function answers a flat `'received'` for pending, repeat,
    already-invited and previously-ignored alike, so it can't be used to probe who's a Margin
    user, and ignoring someone stays quiet rather than becoming an announcement.
  - **Approving is an Edge Function, not a table write** (`supabase/functions/approve-access/`,
    deployed 2026-08-05). It's the only way to do the half the browser can't: create the
    `auth.users` row and mail the person. It re-reads emails from the table by id (never trusts
    an email in the request body), upserts `allowed_emails` **then** calls
    `inviteUserByEmail` — that order, per the trigger above — and marks the row approved.
    Already-registered is treated as success, not failure. Approvals run sequentially because
    the project's Gmail SMTP is rate-limited and a parallel "Approve all" is the reliable way
    to trip it. **Its authorization check is its own**, comparing `getUser(token).id` against
    `ADMIN_USER_ID`: the platform's `verify_jwt` only proves the caller sent *a* valid project
    key, and the anon key is both valid and public. Verified live — a call bearing the anon key
    gets 403, and CORS omits the allow-origin header entirely for an unknown origin rather than
    falling back to `*` (the same fail-closed rule the Worker learned).
  - **`#admin` now has a "Waiting for you" card** above the invite list, with per-row Approve
    and Ignore, an "Approve all" behind a confirm (it sends real email), and previously-ignored
    requests folded into a `<details>`. The two lists load in parallel and are independent: if
    `access_requests` fails to load, the invite list still renders, since that half worked
    before any of this existed.
  - **`guide.html` was updated to match**, since both email templates point first-timers at it
    and it still described the old "I'll need to add your email on my end first, so if sign-in
    doesn't work that's probably why" flow. It now covers both arrival paths — invited (a link
    is already in your inbox) and link-only (the app offers to ask for you, and a real person
    has to approve it, so it won't be instant).
  - **Then audited the whole guide against the running app, 2026-08-05** — it was written
    around Phase 4 and had silently fallen a long way behind. What was wrong:
    - **The privacy disclosure was materially incomplete**, which matters more than the rest
      because the whole point of that list is to say what leaves your device. It named only the
      dictionary API and the AI tab. It did not mention that **photographs** — page scans and
      book covers both — are sent to `generativelanguage.googleapis.com` to be read, or that a
      scanned book's ISBN goes to Open Library for cover art. Now enumerated, with the note
      that Margin itself doesn't keep the photos.
    - **OCR page-scanning and the book library/cover-scanning were absent entirely**, despite
      being the two biggest things built since. Added, including the crop step and the "Enter
      it manually instead" fallback.
    - **The saved list is collapsed by default** since the declutter round; the guide told
      people to tap "Practice above your saved list" without mentioning they have to open the
      list at all. Rewritten, and it now also covers the optional "line from your book" field
      and the **Learned it** toggle (greyed out in the list, excluded from practice).
    - Two label drifts: the multi-sense button is **Save this meaning**, not "Save this sense",
      and lookup fires as you type rather than needing the button. Android's card now also
      mentions the in-app **Install Margin** button.
    - Worth repeating the general lesson: this drifted because nothing links the guide to the
      code. Any round that changes a visible label or a data flow should get a glance at
      `guide.html` before it's called done.
  - **Fixed a real layout bug in `guide.html`'s install steps**, found by screenshotting them.
    `ol.steps li` was `display: flex; gap: 12px`, which makes the counter badge, every text run
    *and* every `<strong>` a separate flex item — so "Tap the **Share** icon (square with an
    arrow)" rendered as three independently-wrapping columns, and the Android step (four bold
    spans) as five. The badge is now absolutely positioned and the li is a normal block, so the
    text flows as one sentence. Worth knowing generally: `display: flex` on anything containing
    mixed inline markup will do this.
- **The `#admin` route has a way in and a way out, 2026-08-05.** An Admin button sits in the
  masthead beside Sign out, rendered only when the signed-in id matches `ADMIN_USER_ID`, and
  carrying the pending count in its label (`Admin · 3`) since there's no notification channel
  yet. This changes nothing about security — the hash was never a secret and RLS is the
  boundary — it just makes the route reachable from a phone. Two supporting moves:
  `ADMIN_USER_ID` moved up next to the Supabase client (`showSignedIn` reads it, and left
  further down it would sit in its temporal dead zone), and `checkAdminRoute()` learned to
  restore the normal screen when the hash *isn't* `#admin` — until there was a Back button,
  the only way off the route was a reload, so that path had never run.

## Picking up next session
- **Branch `onboarding-approval-flow` is the live work.** Not merged, not pushed. `main` is
  otherwise still where everything else landed.
- **The onboarding queue is tested end to end and works.** Done 2026-08-05, both email
  templates are pasted into the dashboard, and `http://localhost:8000` was added to the
  Redirect URLs alongside the production one so local testing can sign in. **Invite emails go
  to Gmail's spam folder**, which cost half an hour of debugging before it turned out to be
  nothing: the auth log showed `POST /invite → 200` with a ~3.8s duration (a real SMTP
  handshake) and `confirmation_sent_at` was set, so everything up to Gmail's own filter was
  working. Nothing to fix in code — the mail is DKIM-signed by Gmail, it's reputation and
  content, not authentication. Two things follow from it:
  - **Tell people to check spam** in the same WhatsApp message as the link. That's the whole
    mitigation, and it's free given every invite is personally sent anyway. `guide.html` now
    says it too, along with the fact that marking one "Not spam" fixes it for good.
  - The other thing seen during that debugging, worth not re-deriving: **a copy of every
    invite appears in debashis9@gmail.com's own mailbox**. That's the Gmail Sent copy, because
    Supabase's SMTP authenticates as that account — not a misrouted email. Check the To: line
    before concluding anything from it.
- **Not built yet, deliberately deferred:** admin notification (email via Resend, or Telegram)
  and invite codes that skip the queue for people you messaged directly. Both were discussed
  and parked to keep this round to one thing.
- **Known, not urgent: "Delete" on the invite list does not revoke anyone who has already
  signed in.** `check_allowed_email()` is a `before insert on auth.users` trigger, so it never
  runs again for an existing account — a soft-deleted email keeps working indefinitely. The
  2026-07-31 note claiming Delete is "a real revocation" is only true for someone who never had
  an account. Confirmed 2026-08-05 that no live user is currently in that state (both accounts
  are on the list, neither deleted), so nothing is leaking today. The fix belongs in
  `approve-access` (ban or delete the `auth.users` row on revoke), which already holds the
  service-role key.
- **Everything else is merged to `main` and pushed.** The three parked features (offline mode, OCR,
  book library) all landed on `main`; `future/ocr-offline-library` is now a leftover branch, not
  where work happens.
- **The 2026-08-04 declutter round is on `main` but has NOT been looked at on a real phone yet**
  — it was reviewed on `localhost:8000` only. Three things debashis9 may still want changed (all
  small): whether "Add a book…" belongs in the Reading dropdown or in the "All books" filter
  beside Saved words (the instruction said "under library drop down", which fits either); the
  dog-ear mark, where the alternative was folding the masthead's own bottom rule at its right end
  instead of a glyph; and the tagline wording ("Catch a word mid-page.").
- **The 2026-08-04 mobile-usability round is verified on a real phone** (sticky crop buttons,
  the wrapped Reading row + library dropdown, the underline/translucent-wash word marking, the
  streaming progress line) — see the entry at the end of Current state. Nothing outstanding
  from it.
  1. **Done 2026-08-04:** `supabase/sql/books-table.sql` is run, a real book was scanned in
     successfully, and the Library screen renders correctly against the real table — book
     scanning/library is fully verified, nothing left to check there.
  2. `sw.js` is at `v40` (bumped 2026-08-05 for the onboarding round). The Worker
     (`worker/src/index.js`) is deployed live and matches what's committed — no pending
     redeploy. The `approve-access` Edge Function is deployed and matches
     `supabase/functions/approve-access/index.ts`.
  3. Decide whether to test OCR on a real Android phone (optional — "Choose a photo" with a
     phone-taken picture has already fully exercised OCR recognition/crop/streaming; only the
     live-camera-specific UX, getUserMedia permission prompt and viewfinder, remains untested,
     and debashis9 has been hesitant about granting camera permissions on mobile). If skipped,
     that's a deliberate choice, not a gap to chase.
  4. Local dev note: `worker/` and the project root are separate directories with their own
     unrelated file listings — running `python3 -m http.server` from inside `worker/` by
     mistake (easy to do right after running deploy commands from there) serves the Worker's
     source files instead of the app; `cd` back to the repo root first.
- **Decided: not swapping the dictionary API source, for now.** Looked at
  freedictionaryapi.com (same Wiktionary data as today, no key, better-structured response)
  and Wordnik (genuinely different curated sources — AHD, Century, WordNet — needs a free
  API key) as alternatives to the current dictionaryapi.dev, prompted by a real quality
  complaint ("incandescent" showing a nonsensical definition). Root cause turned out to be
  an app-side bug (grabbing `meanings[0]` regardless of part of speech), not the API itself —
  fixed by the multi-sense picker above. With that fixed, swapping sources isn't worth the
  effort right now. Revisit only if sense quality is still a complaint after using
  multi-sense for a while; Merriam-Webster stays reserved for if/when this goes fully public.
- **RESOLVED as of 2026-07-24: the second-user magic-link sign-in issue.** The earlier
  `ERR_CONNECTION_RESET` (see prior notes, since removed) didn't recur — confirmed by a real
  second user successfully signing in and saving a word: a distinct `user_id` UUID (not
  debashis9's) now shows up in the Supabase `entries` table. Whatever caused the one-off
  reset was most likely on that person's device/network, not this app, matching the original
  suspicion. No code or config change was needed.

## To-do
- **Worker rate limiting.** Flagged when the Worker had no auth check at all; matters less
  now that every request needs a real signed-in Supabase session (see M4 above), but still
  not there as defense-in-depth against a compromised or overly-eager signed-in account.
- **Revisit if it comes up in practice:** Phase 2's plain-insert save no longer merges a
  word you've already saved into the existing row across books the way the old IndexedDB
  version did — same word from two books now makes two rows. Not fixed since it hasn't
  actually been a problem yet.
- **Consider Sentry (or similar) once the user base grows past a few known testers.**
  Discussed 2026-07-31: not worth the setup cost yet (an account, a CDN script, a new data
  flow to disclose in `guide.html`) while every tester who hits a bug can just text
  debashis9 directly. Becomes worth it once there are users without a direct line, or enough
  of them that manual bug reports stop being representative. Free "Developer" tier covers
  5,000 error events/month, 30-day retention, one seat — comfortably enough for this app's
  scale for a long while. Would help most with: silent unhandled JS exceptions (most
  existing failure paths already have friendly try/catch messages, but a truly unexpected
  one just leaves a blank screen today), Worker-side failures from an API response shape
  changing (already happened twice with Gemma's SSE format and `thinkingBudget`), and
  one-off device-specific bugs like the stale-service-worker issue that only headless
  testing missed.

## Architecture (hold to these)
- **One file:** the whole app lives in `index.html` (HTML + CSS + JS inline), kept readable
  on purpose. Do not split into a build system or framework unless explicitly asked.
- **Plain vanilla JS.** No React, no bundler, no npm dependencies in the app itself. The one
  exception is Supabase JS, loaded via `<script src="...cdn.jsdelivr.net...">` — still no
  build step, so it fits the same spirit.
- **PWA:** `manifest.json` + `sw.js` make it installable. The service worker caches only the
  app shell, never dictionary/API responses (the OCR Worker call included — deliberately live-
  network-only, same as the AI tab). This gap — opening the app fully offline used to fail
  outright, since the Supabase CDN script wasn't cached and saved words lived entirely in
  Supabase with no local fallback — is closed (pinned+cached Supabase SDK, local mirror +
  capture queue), live on `main`; see Current state above.
- **Bump `sw.js`'s `CACHE` version constant whenever `index.html` (or `manifest.json`/icons)
  changes.** The service worker caches `./index.html` itself as part of the app shell — a
  real browser with an existing registration keeps serving whatever was cached under the old
  version string until it changes, even across multiple unrelated code changes and reloads
  (a DevTools "Update on reload" checkbox isn't reliably enough by itself; the sure fix is
  unregistering the old worker + clearing site storage). This bit on 2026-07-24: several
  rounds of `index.html` changes (multi-sense picker, then the AI toggle) shipped without
  bumping `v16`, so a real signed-in browser kept showing the pre-multi-sense, pre-AI-toggle
  card the whole time — automated testing never caught it because a fresh Playwright context
  has no prior service worker registration to go stale.
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
- **Phase 2b: DONE and merged to `main`** — offline caching / local-first sync, using the
  IndexedDB code that had been kept around unused for exactly this (see Current state above
  for details).
- **OCR camera-capture: DONE, verified live, and merged to `main`** (crop-before-send +
  streaming word list, plus two follow-up bug-fix rounds — the second one mobile-usability,
  2026-08-04) — see Current state above.

## Working style
Explain changes in plain terms — I'm learning. Prefer small, reviewable steps over large
rewrites. When unsure about a design or data decision, ask before implementing.

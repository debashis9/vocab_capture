# Margin

**Catch a word you don't know while reading a physical book, look it up, and keep it —
tagged to the book you found it in.**

You're mid-page, you hit a word you don't know, and the friction of looking it up is what
stops you doing it. Margin removes the friction: type the word, say it, or photograph the
page and tap it. It's a [progressive web app](https://web.dev/progressive-web-apps/) —
installs to a home screen, works offline where it can.

🔗 **[debashis9.github.io/vocab_capture](https://debashis9.github.io/vocab_capture/)** ·
📖 **[Install guide](https://debashis9.github.io/vocab_capture/guide.html)** ·
🧭 **[Decisions](DECISIONS.md)** — why it's built this way, and what lost

> Sign-in is invite-only — this is a personal tool being tested by family and friends, not
> a public service. The app is fully browsable without an account.

---

## The one interesting constraint

**The entire app is one HTML file.** Markup, CSS and JavaScript inline in `index.html`. No
framework, no bundler, no build step, no npm dependencies — deploying is `git push`.

Held deliberately through camera OCR, streaming responses, offline sync and an admin panel.
The one exception is the Supabase JS client, from a CDN at a pinned version, which keeps the
no-build-step property intact.

## What it does

**Looking a word up**
- Types-as-you-go lookup against a free dictionary API, with no key required
- **Every sense, grouped by part of speech** — you pick, rather than the app guessing (it
  used to guess, and got "incandescent" embarrassingly wrong)
- Voice input via the Web Speech API
- Pronunciation audio where the dictionary has it
- An optional **AI tab** that writes a definition aware of the book you're reading
- A dictionary miss is never a dead end — the AI tab is one tap away

**Reading off the page**
- **Point the camera at a page**, drag a box round a paragraph, and every word becomes
  tappable — streaming in as it's recognised, not all at once at the end
- **Scan a book's cover** for its title, author and ISBN, with cover art fetched by ISBN
- A "line from your book" field for the sentence a word actually appeared in

**Keeping and practising**
- Saved words filter by book, with a **Learned it** flag that retires them from practice
- **Flashcards and a quiz**, scoped to the filtered book. Wrong answers come from your own
  other saved words, preferring the same part of speech. No AI, no network
- **Offline**: saved words and practice fall back to a local IndexedDB mirror; a word you
  can't look up now is queued and resolved when you're back

**Getting people in**
- Email magic-link sign-in, no passwords
- Invite codes for one-tap access, an access-request queue as the fallback, and a private
  admin screen to approve, invite and revoke

## How it's put together

```
index.html ──────────────► dictionaryapi.dev          free, no key, the default lookup
     │
     ├───────────────────► Cloudflare Worker          holds the API key; every route
     │                     /define-gemma  AI definition   requires a valid Supabase
     │                     /ocr           page OCR         session, verified server-side
     │                     /book-lookup   cover → title/author/ISBN
     │                     (→ Google Gemini API)
     │
     ├───────────────────► Supabase                   auth + Postgres, row-level security
     │                     Edge Functions:            scoped to the signed-in account
     │                       approve-access
     │                       redeem-invite
     │                       send-feedback
     │
     └───────────────────► IndexedDB                  local mirror + offline capture queue
```

**Three rules the code holds to:**

1. **All persistence goes through three functions** (`saveEntry` / `getEntries` /
   `deleteEntry`); the UI never touches storage directly. Swapping IndexedDB for Supabase
   changed those three and nothing else.
2. **No secrets in this repo.** API keys live only in the Worker's environment. The Supabase
   anon key *is* in the client by design — row-level security, not key secrecy, protects the
   data.
3. **Calm and editorial** — warm paper, oxblood accent, Fraunces for the word and Inter for
   the interface. Accessible, and it has to work on a phone.

Why a 26B model instead of an OCR library, security in the database rather than the app,
invite codes instead of notifications — **[DECISIONS.md](DECISIONS.md)**, including the ones
where the first answer was wrong.

## What leaves your device

Each of these only happens because you asked for it:

| What | Where | When |
|---|---|---|
| The word you typed | dictionaryapi.dev | Every lookup (the default) |
| The word + the book title | Google Gemini, via the Worker | Only if you open the AI tab |
| A photo of a page or book cover | Google Gemini, via the Worker | Only when you scan |
| A scanned book's ISBN | Open Library | To fetch cover art |
| Your saved words | Supabase, private to your account | When you save |
| Feedback text, your email, your browser | Supabase, then my inbox | Only if you use Send feedback |

Photos are read and discarded — Margin doesn't store them. There's no analytics and no
third-party tracking of any kind.

## Repo layout

```
index.html                  the whole app
sw.js                       service worker (app shell cache; bump CACHE on every change)
manifest.json               PWA manifest
guide.html                  install + testing guide for testers
icons/                      app icons, plus icon-source.html which generates them
worker/                     Cloudflare Worker — the LLM proxy
supabase/sql/               schema, RLS policies and functions, run by hand in the SQL editor
supabase/functions/         Edge Functions (approve-access, redeem-invite, send-feedback)
supabase/email-templates/   tracked copies of the auth emails (the dashboard is the source of truth)
```

## Running it locally

A static file server is all it takes:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Sign-in needs `http://localhost:8000` in the Supabase project's Redirect URLs. For the
Worker:

```bash
cd worker
npm install
npx wrangler dev          # needs GEMINI_API_KEY in .dev.vars (gitignored)
```

The SQL in `supabase/sql/` is applied by hand through the Supabase SQL editor, in the order
described in each file's header comment.

## Status

Personal project, actively used, rough in places by design. Built with
[Claude Code](https://claude.com/claude-code), including most of the debugging rounds behind
the decisions above.

No license yet, so default copyright applies: read it, learn from it, but it isn't offered
for reuse as-is.

# Margin LLM proxy (M4)

A small Cloudflare Worker that holds the Anthropic API key server-side and generates
AI-upgraded word definitions with Claude Haiku 4.5. It exists so the key never has to sit
in `index.html`'s JavaScript, where anyone could read it from dev tools.

**Status: built and locally tested, but dormant.** The frontend button is feature-flagged
off (`AI_ENABLED = false` in `../index.html`) because API usage is billed separately from
any Claude.ai subscription, and we decided to hold off on that ongoing cost until there's a
reason to scale past personal use.

## What it does

`POST /define` with `{ "word": "...", "book": "..." }` (book is optional) returns a
definition in the same shape the free-dictionary path already produces — `word, pos,
definition, example, synonyms, antonyms` — so the app's existing card renderer and save
logic don't need to know which source it came from. If a book title is given, the prompt
asks Claude to prefer the sense of the word that fits that kind of book, and to write the
example sentence in a voice that could belong to it.

## Local testing

1. `npm install` (needs Node 22+ — this repo pins it via `.nvmrc`; `nvm use` picks it up)
2. Put your Anthropic API key in `.dev.vars` (git-ignored, never commit it):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. `npm run dev` — runs the Worker at `http://localhost:8787`, matching the
   `AI_ENDPOINT` constant already in `index.html`.
4. Serve the app itself (`python3 -m http.server 8000` from the repo root) and flip
   `AI_ENABLED` to `true` locally (don't commit that flip) to see the button.

## Activating it for real

1. Add credits to the Anthropic Console account this key belongs to (Plans & Billing) —
   API usage is pay-as-you-go, separate from any Claude.ai subscription. At the estimated
   cost per lookup (~$0.0015), this is a small amount even for regular personal use.
2. Deploy: `npx wrangler login` (once), then `npm run deploy`.
3. Store the real key as a Cloudflare secret, not in a file:
   `npx wrangler secret put ANTHROPIC_API_KEY`
4. In `wrangler.toml`, set `ALLOWED_ORIGIN` to your actual GitHub Pages origin (e.g.
   `https://<you>.github.io`, no trailing slash) so only your app can call the proxy.
5. In `index.html`, update `AI_ENDPOINT` to the deployed Worker's URL and flip
   `AI_ENABLED` to `true`.
6. If opening this up beyond friends/family, add rate limiting on the Worker — right now
   anyone with the deployed URL could call it and run up the bill.

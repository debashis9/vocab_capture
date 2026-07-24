# Margin LLM proxy (M4)

A small Cloudflare Worker that holds API keys server-side and generates AI-upgraded word
definitions. It exists so the keys never have to sit in `index.html`'s JavaScript, where
anyone could read them from dev tools.

**Status: live**, deployed at `https://margin-llm-proxy.debashis9.workers.dev`. The app's
"AI" tab (`AI_ENABLED = true` in `../index.html`) calls this Worker's `/define-gemma` route,
which uses Gemma 4 (26B MoE, `gemma-4-26b-a4b-it`) via Google's free-tier Gemini API — not
Claude Haiku as originally planned here, since Gemma is genuinely free at this scale and,
after a latency-tuning pass, fast enough (~2.8-3.2s total, ~1.2-1.5s to first token).

## Routes

Both return the same shape — `word, pos, definition, example, synonyms, antonyms` — so the
app's card renderer and save logic don't need to know which source produced it. Both accept
`POST { "word": "...", "book": "..." }` (book is optional); if given, the model is asked to
prefer the sense of the word that fits that kind of book and to write the example sentence
in a voice that could belong to it.

- **`/define-gemma`** — the live path. Also accepts `"model": "26b" | "31b"` (defaults to
  `26b`); the 31B Dense variant was tested and works but wasn't meaningfully better for this
  task in side-by-side comparison, so 26B stayed the default. Response includes a `_timing:
  {ttft_ms, total_ms}` field for observability — harmless to ignore, the frontend doesn't
  use it.
- **`/define`** — the original Claude Haiku 4.5 path. Still in the code, but the
  `ANTHROPIC_API_KEY` behind it currently has zero credits, so this route 400s in practice.
  Kept rather than deleted in case Gemma's free tier or quality ever changes and this needs
  revisiting.

## Local testing

1. `npm install` (needs Node 22+ — this repo pins it via `.nvmrc`; `nvm use` picks it up)
2. Put your API key(s) in `.dev.vars` (git-ignored, never commit it):
   ```
   ANTHROPIC_API_KEY=<your-anthropic-key>
   GEMINI_API_KEY=<your-gemini-key>
   ```
   Get a free Gemini key at `aistudio.google.com/apikey` — Google account, no credit card.
3. `npm run dev` — runs the Worker at `http://localhost:8787`.
4. Serve the app itself (`python3 -m http.server 8000` from the repo root); `AI_ENDPOINT` in
   `index.html` points at the deployed Worker by default — repoint it at
   `http://localhost:8787/define-gemma` locally if you want to test against a local Worker
   instead of the live one.

## Redeploying after a code change

1. `npx wrangler login` (once per machine — opens a browser to authorize; the local process
   started by this command has to still be running when you click "Authorize" in the
   browser, so do it in one continuous sitting rather than pausing partway through).
2. `npm run deploy`.
3. Secrets and `wrangler.toml`'s `ALLOWED_ORIGIN` (set to the live GitHub Pages origin) are
   already configured on the deployed Worker — only re-run `wrangler secret put <NAME>` if a
   key itself changes, not on every code deploy.
4. If opening this up beyond friends/family, add rate limiting on the Worker — right now
   anyone with the deployed URL could call it. Not a cost risk with Gemma's free tier the
   way it would have been with a paid Claude key, but still worth doing before wider use.

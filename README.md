# vocab_capture
# Margin — build runbook

Your standalone vocabulary app. This folder now covers **Milestones M0–M3 and M5** from the
project plan: an installable app (M0) that looks up a typed word from a free dictionary and
shows it as a card (M1), saves it locally with a filterable/deletable list (M2), accepts
voice input (M3), and has a round of polish (M5): an offline-aware error message, an in-app
install button, and a dark theme. Next up is M4, the optional LLM-upgraded definitions — see
the milestone status at the bottom.

---

## What's in this folder

```
vocab-capture/
├─ index.html      ← the whole app (HTML + CSS + JS in one file, on purpose, so it's easy to read)
├─ manifest.json   ← makes it installable, names it, gives it an icon
├─ sw.js           ← service worker: lets the app open offline + be installed
├─ icons/
│  ├─ icon-192.png
│  └─ icon-512.png
└─ README.md       ← you're reading it
```

Put this folder inside your project directory in WSL/Ubuntu.

---

## 1. Run it locally (on your Windows PC)

A PWA has to be *served*, not opened as a file. From inside the folder, in your Ubuntu shell:

```bash
cd vocab-capture
python3 -m http.server 8000
```

Then open **http://localhost:8000** in Edge or Chrome on Windows. (WSL2 forwards `localhost`
to Windows automatically, so this just works.) Type a word, press Enter — you should get a card.

Stop the server later with `Ctrl+C`.

---

## 2. Install it on Windows (get the icon — this is the M0 proof)

With the app open at `http://localhost:8000` in Edge/Chrome:

- Look in the address bar for an **install icon** (a small monitor with a ⤓), or open the
  browser menu → **Apps → Install this site as an app** / **Install Margin**.
- Confirm. It opens in its own window and lands in your Start menu.

If the install option appears, **M0 is proven on Windows.** If it doesn't, tell me — it's almost
always the service worker not registering, and it's a quick fix.

---

## 3. Install it on Android (needs a real HTTPS address)

Your phone can't reach the `localhost` server running in WSL, and install on Android requires
HTTPS. So put the folder online — free, takes a minute. Two options:

**Fastest (throwaway test):** go to **app.netlify.com/drop** in a browser and drag the
`vocab-capture` folder onto the page. It gives you an `https://…netlify.app` URL instantly.

**Proper home (what we'll use going forward):** GitHub Pages.
```bash
# from inside vocab-capture/, once:
git init && git add . && git commit -m "M0+M1: installable lookup"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/margin.git
git push -u origin main
```
Then on GitHub: **Settings → Pages → Deploy from branch → main / root**. Your app appears at
`https://<you>.github.io/margin/`.

On the phone, open that HTTPS URL in Chrome → menu (⋮) → **Add to Home screen** / **Install app**.
Launch it from the new icon. If it opens fullscreen with no browser bar, **M0 is proven on
Android.**

---

## 4. How we work from here

- **This file + the project-plan doc = your reference.** Come back to them anytime.
- **Claude Code (in this terminal) = your builder for the next milestones.** It's included in your
  Pro plan, so building costs nothing. Start it in the folder with `claude`.
- **The Claude.ai chat = your architect.** Bring back errors, screenshots, and "what's next?"
  questions there.

### Suggested first Claude Code task (this is M2 — saving words)

Paste something like this to Claude Code once M0 is proven:

> In this folder there's a single-file PWA (`index.html`). Add local saving using **IndexedDB**.
> When a lookup succeeds, show a **"Save to list"** button. Saving stores an entry with these
> fields: `id, word, meaning, partOfSpeech, synonyms, antonyms, example, book, source, savedAt`
> (source is "typed" for now; book comes from the "Reading" field). Below the lookup, add a
> **saved list** that loads on open, shows word + book + date, can **filter by book**, and lets me
> **delete** an entry. Keep everything in one file and keep the existing visual style. Wrap all
> storage in a small module (`saveEntry`, `getEntries`, `deleteEntry`) so we can swap in a cloud
> database later without touching the UI.

That "small storage module" instruction matters — it's what makes the Phase 2 sync upgrade a clean
swap instead of a rewrite.

---

## Milestone status

- [x] **M0** — installable PWA shell (this folder)
- [x] **M1** — typed lookup + result card (free dictionary API)
- [x] **M2** — save to IndexedDB, list + filter by book + delete
- [x] **M3** — voice input (mic button)
- [x] **M4** — built (Cloudflare Worker + Claude Haiku 4.5), but feature-flagged off pending
  a revenue-backed billing decision — see `worker/README.md`
- [x] **M5** — polish: offline-aware error message, in-app install button, dark theme
- [x] **Phase 4** — flashcards + quiz, scoped to the current book filter, no auth needed

Beyond the original M2/M3 spec, also shipped: pronunciation audio playback on the result
card and saved list, same-word dedup (saving a word you've already saved merges the new
book into that entry instead of creating a duplicate), a clear-text button on the word
field, and a light/dark/system theme toggle.

**Not started:** Phase 2 (cloud sync — saved words currently live only on the device that
saved them, per the limit below).

## Known Phase-1 limits (all expected)

- The free dictionary misses rare/proper words and gives no context-aware sense — that's what the
  later LLM upgrade fixes.
- Saved words live only on the device that saved them until Phase 2 (cloud sync).

# Decisions

Margin is small enough that most of its code explains itself. What the code can't explain is
why it isn't something else — why a 26B model instead of a purpose-built OCR library, why the
security boundary sits in the database rather than the app, why there's no notification system
for the admin.

This file is that record. Each entry is a decision, the alternative that lost, and the reason.
Most were written up after the fact, from a working journal, so several include what it
actually cost — including the ones where the first answer was wrong.

For the map of how the pieces fit together, see the [README](README.md).

---

## The shape of the app

### One HTML file, no build step

`index.html` holds the markup, styles and logic inline. No framework, no bundler, no npm
dependencies in the app itself.

The alternative was the obvious one: a build step, a component framework, split files. It was
rejected at the start and has been re-tested by every feature since — camera OCR, streaming
responses, offline sync, an admin panel. None of them forced the issue.

What it buys: the whole app is readable top to bottom, deploying is `git push`, and there is no
toolchain to rot between sessions on a project that gets picked up every few weeks. What it
costs: real discipline about file size, and no module system to lean on.

The one exception is the Supabase client, loaded from a CDN at a pinned exact version. It's a
dependency, but it doesn't reintroduce a build step, so it fits the spirit. It's pinned rather
than floating because the service worker caches it by exact URL — a floating tag would drift
away from the cached copy and silently never match.

### All persistence behind three functions

Every read and write goes through `saveEntry`, `getEntries` and `deleteEntry`. The UI never
touches storage directly.

This was set up in the first week, before there was anything to store, on the theory that the
storage layer would eventually change. It did: the app began on IndexedDB and moved to Supabase
for cross-device sync. That migration changed those three functions and nothing else.

It's the clearest case in this project of a constraint paying for itself, and it's why the
offline mirror could later be added underneath the same three functions without the rest of the
app knowing.

---

## Words and definitions

### A free dictionary API as the default, not an AI model

Every lookup goes to a free public dictionary built on Wiktionary data — no key, no account.
The AI path exists, but it is opt-in and never fires on its own.

Dictionaries are better at being dictionaries. They're faster, they're free, they don't
hallucinate, and for the overwhelming majority of words the answer is simply correct. Sending
every lookup to a language model would have been slower, less reliable, and would have spent
quota on words that a static dataset already answers perfectly.

### Fix the sense-picking bug rather than switch dictionary providers

A complaint that "incandescent" returned a nonsensical definition looked like a data-quality
problem, and two replacement providers were evaluated on that basis.

The root cause turned out to be in this app: it was taking the first meaning of the first part
of speech and discarding the rest, so a common adjective lost to a rare noun sitting next to it
in the same response. The data had been right all along.

The fix was to show every sense grouped by part of speech and let the reader choose. Switching
providers would have changed the symptom for one word and left the bug in place for every other.
**The general lesson: confirm the layer before replacing it.**

### Gemma via Gemini's free tier, not Claude Haiku

The original plan named Claude Haiku. Gemma 4 shipped instead, on Google's free tier.

Cost decided it — free against roughly a tenth of a cent per lookup. For a personal app that
sounds like rounding error, but it's the difference between a service that costs nothing to
leave running for years and one with a bill attached, however small.

Latency was the reason it nearly didn't happen: the first working version took about 19 seconds,
which is unusable. That was fixed rather than accepted (see below), and once it was, cost was
the only distinguishing factor left.

### Make the model think less, and stream the answer

The 19-second first attempt was spending roughly ten times as many tokens on internal reasoning
as on the answer itself — for a task that is "define this word in a sentence or two."

Four changes together brought it to about three seconds, with the first token in under two:
minimal thinking, a capped output length, a trimmed prompt, and a switch from a blocking call to
a streaming one. The streaming change didn't make the total faster so much as make it *feel*
faster, by making time-to-first-token visible at all.

Two things worth knowing if you're doing the same:

- `thinkingBudget: 0` works on other Gemini models and is flatly rejected for this one. The
  documented knob is not always the working knob — verify against the live API.
- This API's server-sent events use `\r\n` line endings. A frame parser that splits on `\n`
  produces no output at all, silently, with no error to follow.

### A dictionary miss still renders the card

A word the dictionary doesn't have used to print a bare error string. No card, no tabs — which
meant the AI tab was unreachable for precisely the words that most needed it: names, slang, and
anything coined recently.

Now a failed lookup builds a stub result and goes through the normal render path, so the card
and its tabs appear as usual with the miss explained inside. The AI tab sits one tap away but
still doesn't fire by itself, so a typo doesn't quietly spend quota.

The principle this is an instance of: **a failure should leave you somewhere you can act, not at
a dead end.** The same thinking put a manual-entry fallback behind book scanning, and a
"save for later" queue behind an offline lookup.

---

## Reading off the page

### A multimodal model, not a client-side OCR library

Pointing the camera at a page and tapping a word is the feature that makes the app worth opening
mid-chapter. The obvious implementation is a browser OCR library running locally.

Two reasons it went the other way. First, dependencies: an OCR library is a second large CDN
dependency, and the one-file rule allows exactly one exception. Second, and more decisive:
real pages photographed by hand are bad inputs — curled paper, uneven light, an angle, a thumb.
Traditional OCR degrades sharply on all of that; a multimodal model tolerates it well.

The cost is honest: page scanning cannot work offline, and it sends a photograph to a third
party. Both are disclosed in the app's own FAQ rather than buried.

### Crop before sending, and stream the words back

A full page took 60–90 seconds and then dumped every word at once. Two changes fixed it
together.

Cropping first is the real lever — you drag a box around the paragraph you care about, and the
model is asked to read a fraction of the page. Fewer output tokens is most of the time saved.
The crop is taken from the original full-resolution capture rather than a copy already shrunk
for whole-page use, so a small selection ends up with *more* detail per word, not less.

Streaming is the other half: each recognised word is forwarded and becomes tappable the moment
it's complete, instead of after the whole list arrives.

Streaming also dissolved a bug rather than patching it. Occasionally the model would emit an
unescaped quote inside a word, which broke a single parse of the whole response — one bad
character invalidating a hundred good words. Parsing incrementally means a malformed entry
simply never completes and is skipped. The retry logic written for that bug was deleted as
superseded, not kept alongside.

### Tapping a word pauses the scan; only closing cancels it

Tapping a word early in a long scan used to abandon the rest with no way back to the photo.

Tapping now pauses: the photo and everything recognised so far are still there when you return.
Only an explicit close cancels the in-flight request, and that genuinely aborts it rather than
letting it run on to fill a list nobody will read.

The reasoning generalises: **the destructive interpretation should require the more deliberate
gesture.** Tapping a word means "I want this one," not "throw away everything else."

### Book covers reuse the model, not a barcode library

Scanning a book's cover reads its title, author and ISBN with the same vision model. There is no
barcode-decoding dependency, for the same reason there's no OCR library — and because the ISBN
digits are always printed as human-readable text right beside the barcode, so a photograph is
enough.

Unlike page scanning this is a single non-streaming call: one small result, not a growing list,
so there's nothing for streaming to improve.

It was also deliberately built as its own small flow rather than reusing the page scanner's
crop/stream/pause machinery. That machinery exists for "tap a word from a growing list," which
doesn't apply here. The rule adopted: **factor out the shared helper when a third case appears,
not the second.**

---

## Data and access

### Row-level security is the boundary; client checks are courtesy

Every table is scoped in the database to the account making the request. The admin screen's
"not authorised" message, and the fact that the admin button only renders for one account, are
user experience — not security. A non-admin who reaches the route gets empty results from the
database regardless of what the interface decided.

This is also why the public API key sits in the client source in plain sight. It's designed to
be public. What protects the data is the policy layer, not the secrecy of that key — and
conflating the two is how people end up believing an app is safe because a key was hidden.

### The Worker verifies sessions by asking Supabase, not by checking signatures

Every route on the proxy requires a real signed-in session, verified by calling Supabase's own
user endpoint with the caller's token.

Verifying the token signature inside the Worker would be faster and would avoid a network round
trip. It would also mean writing token-validation code, which is the kind of thing that is easy
to write and hard to write correctly. Asking the issuer is slower and much harder to get subtly
wrong.

This was added after discovering the endpoint had no authentication at all — a plain command-line
request returned a real definition. Anyone with the URL, which is readable in the page source,
could spend the quota.

A second bug surfaced in the same pass and is worth recording because of how it presented:
unrecognised paths fell through to a different backend instead of returning 404, so a simple
wrong-URL test produced a confusing authentication error from an unrelated service. **A
fall-through default turns a typo into a misleading error.**

### Account creation is gated by a database trigger

Being on the invite list is checked by a trigger at the moment an account is created, not by the
application.

The consequence is unintuitive and has caught us out: the invite list is not a login list. It
grants permission for an account that doesn't exist yet. Adding someone to it does nothing on its
own, and removing someone who has already signed in doesn't lock them out, because the trigger
never runs again for an existing account.

That second half was a real bug, believed fixed for a while because it had only ever been tested
against an address that had never had an account. Which is its own lesson: **a test that passes
for the wrong reason is worse than no test.**

### Revocation uses the auth system's own field

Removing someone bans the account using the field the auth system provides for exactly that, and
clears their existing sessions and refresh tokens so a live login can't keep renewing itself.

The alternative was a trigger on the auth system's internal session tables. It would work, and
it's a much worse idea: raising errors from inside another system's internals breaks on their
next upgrade, and surfaces to the person signing in as an opaque server error. Use the supported
field.

Two limits are accepted rather than engineered around: an already-issued access token stays valid
until it expires, so someone with the app open keeps their own saved words on screen for a while;
and their data is kept, because this means "no longer allowed in", not "erase this person".

### Revoke and restore are one function

They have to move together. A previously-revoked address has a banned account, so restoring only
the list entry puts someone back on the list still unable to sign in.

That is exactly what happened when the two halves lived in different places — one on a button,
one in a form. Combining them isn't tidiness, it's the fix for a bug that had already occurred.
The admin screen now has no direct writes to that table left at all, and a test asserts it.

### Invite codes instead of a notification channel for the admin

People waiting for access needed the admin to notice them. The obvious answer is a notification —
email, Telegram, something.

A code was built instead, because the framing was wrong. A notification makes the admin a
*faster* bottleneck; a code removes the admin from the path entirely. Someone with a link gets in
without anyone being told.

The failure modes also differ in an important way. A notification channel that quietly breaks
looks exactly like "no requests" — so you stop checking, and end up slower than before you built
it. A code that stops working is noticed immediately, by the person it's failing.

The request queue still exists as the fallback for anyone who lost the code or was forwarded a
bare link. That's rare and never urgent, which is the right shape for a fallback.

### Every rejected code gets the same answer

Expired, disabled, used up and never-existed are indistinguishable to the caller. So is a request
from someone already on the list, versus a stranger, versus someone previously turned down.

Different responses for different reasons are an oracle: they let someone map valid codes by
comparing replies, and let them probe who is already a user. Uniform answers also mean that
declining someone stays quiet, instead of becoming an announcement to them.

### Approving happens in a server function, not a table write

Approving does two things the browser cannot: create the account and send mail. It re-reads the
address from the table by id rather than trusting anything in the request, and does its work in
the one order the trigger above permits.

Its authorisation check is its own, comparing the caller's user id against the admin's. The
platform's built-in verification only proves the caller presented *a* valid key for the project —
and the public key is both valid and public. **A check that everyone can pass is not a check.**

Approvals also run one at a time rather than in parallel, because the mail provider is
rate-limited and a parallel "approve all" is the reliable way to trip it.

---

## Delivery and offline

### The local mirror refreshes only on unfiltered reads

Saved words are mirrored to local storage so the list and practice work with no connection. The
mirror is refreshed after a successful read of *everything* — never after a read filtered to one
book.

A filtered read returns one book's words. Writing that to the mirror would erase every other
book's cached entries the next time someone happened to have a filter selected. The bug wouldn't
appear during testing, only later, as data that quietly went missing.

### Trust a failed read, not the browser's online flag

The fallback to local data was originally gated on the browser's own online/offline flag. On a
real phone, on a real network, that flag reported "online" while reads were genuinely failing.

It now falls back on any read failure, unconditionally. The flag is a hint about the network
interface, not a fact about whether your request will succeed. **The reliable signal that
something failed is that it failed.**

Worth noting how this was found: automated testing uses the browser automation tool's offline
emulation, which is perfectly reliable and therefore never reproduced it. It took using the app
on a real device on real Wi-Fi.

### The service worker fetches the shell bypassing the HTTP cache

Bumping the cache version alone does not guarantee fresh files. A brand-new, correctly-named
cache can be filled with a stale copy served from the browser's ordinary HTTP cache — so the
version string changes, the cache is genuinely new, and the contents are old.

Each shell file is now fetched with an explicit reload, forcing a real network request.

The related discipline, learned the hard way: **bump the cache version on every change to the
app shell.** Several rounds of work once shipped without it and were invisible in a real browser
for days, while automated tests passed continuously — a fresh test browser has no previous
service worker to go stale, so it can never catch this class of bug.

---

## Visual identity

### The icon carries the idea; the wordmark stays type

The app icon is a red margin rule down a ruled page with an M in the writing area. The margin
band is both what makes it legible at small size and the concept itself — nothing in it exists
purely to be visible.

Bringing that further into the app was tried and mostly rejected. Setting the icon's M as the
first letter of the word breaks the word: a chip is a closed shape, so it reads as "M" then
"argin", the chip's padding opens a gap kerning can't close, and on a dark background a paper
chip becomes a sticker sitting inside a word.

What shipped is the margin rule alone, standing before the wordmark. The version with the word
resting on a ruled line was rejected for a specific reason worth recording: it would introduce a
new colour into the interface palette. An icon is a self-contained object and can hold a colour
that appears nowhere else; the interface can't.

### Centre the letter on the tile, not in the space beside the band

The first version of that icon put its M in the middle of the paper area left over to the right
of the margin band. That is the obvious reading of "centre it", and it looks wrong: the letter
sits noticeably right of where the eye expects, and the space between band and letter opens into
a gap that reads as a mistake rather than as a margin.

The fix was to centre the M on the whole tile and narrow the band until the two no longer
collide. The same correction applies to the wordmark, where the rule now stands 6px from the M
rather than 12px. The general point: a band and the thing beside it are read as one mark, and the
composition is judged against the frame, not against the leftover area.

The blue rules that suggested ruled paper came out at the same time, and the letter changed from
ink to oxblood. Ruled paper had been load-bearing for the earlier design — a warm on-palette rule
vanished at icon size, so the rules had to be blue, which was the one place a foreign colour was
tolerated. Removing the rules removes the need for that exception, and the icon is now two
colours on paper.

The reproducibility rule holds: the icons are generated by a checked-in HTML file rather than
being mystery binaries, and the maskable variant is now that same composition scaled about the
centre rather than a second hand-tuned layout — which is exactly how the two drifted apart
before. The one thing that does not scale is written into the file: the band's inner edge scales,
its outer edge stays welded to x=0.

---

## The quiet parts of the interface

### Help lives in the footer, not on a glyph in the masthead

The FAQ used to open from a dog-eared page corner beside the wordmark. The symbolism was right
and the discoverability was not: a small unlabelled glyph next to a title is read as decoration,
and it competed with the masthead's job of getting out of the way.

It is now a plain "FAQ" text button in a footer bar at the end of the page, next to "Send
feedback". This costs the masthead nothing, puts help where people already look for it, and lets
the two panels open next to the buttons that open them. They are mutually exclusive — both occupy
the same place, so opening one while the other is open would shove it out from under the reader.

The FAQ works signed out. Someone deciding whether to ask for access should be able to read what
the app does with their things before asking. Feedback does not, because it posts under a
verified session; a stranger who cannot get in has the request-access form for that.

The FAQ also gained an opening question, "What is Margin?". It previously began with "Where do
the definitions come from?", which assumes the reader already knows what they are looking at.

### Feedback is stored first and mailed second

The feedback box could have been a `mailto:` link. That was rejected: it depends on the device
having a mail client configured, it puts the message in a window the app cannot confirm was ever
sent, and it silently does nothing on a phone where mail is only ever read in a browser.

It could equally have been a table alone, read from the admin screen. That was rejected too, for
a duller reason — a queue nobody is told about is a queue nobody checks.

So it is both, in a fixed order: write the row, then try to send the mail. Mail is the part that
fails. It is rate-limited, it is filtered, and it is the half that depends on a secret being set
correctly. Writing the row first means a failed send costs the notification, not the feedback,
and the reason it failed is recorded on the row rather than being assumed. The same ordering
logic appears in the invite flow, where the list entry is written before the account is created.

Identity comes from the caller's verified session, never from the request body — there is no
email field in the request at all. This is the same rule as approving an access request by id
rather than by the email the client sent.

### The invite button copies a message, not a URL

Every invite to this app is sent by hand, to one person, usually over WhatsApp. A bare link
pasted into a chat says nothing about what it is, who it is from, or why it arrived — and the one
thing the recipient genuinely needs to know is not in the link at all: that the sign-in email
will probably be filtered as spam the first time.

So the button copies a whole short message with the link in the middle: a greeting, two bullets
on what the app does, the link, the spam warning, and a nudge towards the in-app feedback button.
The register is deliberately different from the invite *email*, which is written flat and
prose-heavy because that structure survives spam filters better. A chat message isn't filtered,
so it can afford to be scannable. This is not a template
system and it should not become one; it is one message, kept short enough to send unedited, that
carries the one operational fact the link cannot.

---

## Deliberately not built

**Error monitoring.** Considered and deferred. Every tester currently has a direct line to the
author, so a bug becomes a text message within minutes — which is better signal than an
automated report. It becomes worth the setup, and the extra data flow to disclose, once there
are users without that direct line, or enough of them that hand-reported bugs stop being
representative.

**A public dictionary swap.** Two alternative providers were evaluated and neither was adopted;
see the sense-picking entry above for why the premise was wrong. Revisit only if quality is still
a complaint now that all senses are shown.

**Merging duplicate saves across books.** The original local-storage version merged a word saved
from a second book into the existing row. The current version inserts a second row. This is a
known regression from the cloud migration, left alone deliberately because it has not yet been a
problem in practice. Recorded here so that if it ever is, nobody has to rediscover that it used
to work differently.

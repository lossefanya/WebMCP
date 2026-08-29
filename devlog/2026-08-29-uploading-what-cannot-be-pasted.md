# 2026-08-29 — Uploading what cannot be pasted, and four premises that did not survive being checked

The user reported that WebMCP freezes Chrome when it pastes a big file back into a chat, and asked
whether the result could go through the host's own file-upload control instead. The session built
that, for all four hosts. It then spent as long again on things that came out of the user testing it:
a read budget one long line could walk straight past, an attachment named after nothing, a transcript
being replayed as a work queue, and a complaint fired at a tool call the model had not finished
writing.

The through-line is uncomfortable and worth stating up front. Four of the fixes here started as
something I had asserted and defended — the 64 KiB cap was universal, the `.md` suffix was necessary,
the filename did not need the source name, the scanner could not know a call's age. Each was checked
because the user pushed back, and each was wrong.

**Final state:** 471 tests green (227 daemon, 244 extension), up from 395 (214, 181) in the previous
entry. 37 files changed, 3,339 insertions, 82 deletions. Eight new files:
`content/attach.ts`, `content/gate.ts` and `content/history.ts` in the extension, their four test
files, and two DOM fixtures (`chatgpt-uploaders.ts`, `gemini-upload-menu.ts`).

---

## The bug behind the bug: a budget that one line could walk past

The first answer given to the user was that the paste is already capped at 64 KiB
(`limits.maxReadBytes`), so the freeze had to be about *how* the text is inserted rather than how
much of it there is. That was right about the insertion path and wrong about the cap.

`readLineRange` in `packages/daemon/src/tools/fs.ts` emitted at least one line whatever its size:

```ts
// Always emit at least one line, even a pathologically long one, so a file
// of one huge line is not silently unreadable.
if (out.length > 0 && outBytes + bytes > maxBytes) {
```

The `out.length > 0` guard is the whole problem. For the first line there is no budget check at all,
so a 200 KB minified bundle, a single-line JSON blob or one long log line came back *whole* — the
64 KiB cap simply did not apply to the shape of file most likely to be enormous. That result then
went into a Lexical composer as one `execCommand("insertText")` call.

This surfaced as a test failure. The new daemon test asserted `truncated === true` for a 200 KB file
and got `false`; the fixture happened to be `"x".repeat(200_000)` on one line.

**Fix:** the first line is emitted *cut to the budget* with `sliceBytes`, and the footer says
something different when that happens. The usual footer names a resume offset, and here that would be
a lie — `offset: n + 1` starts at the *next* line, so the rest of the cut line is not reachable by
paging at all:

```
[webmcp: line 1 of wide.txt is longer than the 65536-byte result budget and was cut.
 Paging with offset cannot recover the rest of it]
```

Verified against a live daemon rather than only in the suite: a 200 KB single-line file now returns
65,695 characters (header + 65,536 + that notice).

### What the tests had not caught

`fs.test.ts` had good paging coverage — walking a 3,000-line file page by page, checking every line
appears exactly once, checking multi-byte characters survive chunk boundaries. Every one of those
fixtures was many short lines. The one-line file is the degenerate case of the same function and
nobody had written it down. The comment above the branch even described the behaviour as intentional,
which is how it survived review: it reads as a deliberate trade-off rather than an unbounded path.

---

## Uploading instead of pasting

The feature the user asked for. Past the paste budget, a result now goes up through the host's own
`input[type="file"]` and the turn carries a short covering note naming it.

### The threshold belongs to the daemon

The first sketch had the extension decide: daemon always sends the full body, extension pastes if
small and uploads if large. Rejected — it puts a policy in the half that is supposed to hold none,
and it means the daemon's own `maxReadBytes` no longer describes what leaves.

What landed instead: `call_tool` carries `canAttach`, the page saying it *has* an uploader.
`maxReadBytes` still decides oversized; `maxAttachBytes` (1 MiB, new) is the ceiling when uploading
is possible; and the daemon marks the result with `attach: { filename, mediaType }`. The extension
obeys or declines, never widens.

`canAttach` is the one field on that message a hostile page can influence, so it was written to be
harmless when it lies: it changes how many bytes come back, not what may be read. A page that can
call `fs_read` at all could already page the same file with `offset`. The bound is
`limits.maxAttachBytes`, which lives in the config file the browser cannot reach.

### An unconfirmed upload has to count as a failure

The tempting shortcut is to dispatch `change` and assume it worked. It does not fail closed: an
upload is a network round trip that can be refused for size, for type, or for being logged out, and
the result of assuming is a turn that says "the full output is attached" with nothing attached. The
model then answers from the covering note — a *worse* outcome than truncation, because it looks like
an answer rather than a shortfall. That is the same failure shape as the `fs_read` "past the end"
bug from an earlier session: an empty result read as a real one.

So `attachFile` waits for the host to render the file and treats silence as failure, clearing the
input so a late upload cannot duplicate the result. Confirmation matches the filename **stem**, not
the whole filename, because these chips drop the extension — Perplexity's own document card in the
DOM the user pasted shows `japanese_kaiji_joyo_list` for an uploaded file. The stem carries the call
id, so it cannot collide with the conversation's text.

Every failure — no input, wrong `accept`, no `DataTransfer`, no confirmation — falls back to pasting
a shortened result. That path is the behaviour that existed before this session, so the worst case is
a return to the status quo rather than a broken delivery.

### Gemini needs the menu opened first, which the fixture proved

The user sent the DOM of Gemini's upload menu after the first pass had landed, asking whether it was
wanted. It was — and it changed the design rather than just adding a selector.

Grepping the existing `gemini-input.ts` fixture, captured in the zero state, settles it: **zero**
`type="file"` elements and **zero** `<uploader>` elements. What the user sent is `cdk-overlay-31`,
built on demand when `button[aria-label="Upload and tools"]` is clicked. So on Gemini `fileInput()`
is null at rest, `canAttach` would be false forever, and adding the selector on its own would have
been dead code that looked like support.

Making it work means clicking a button on the user's page unprompted, which is the thing this project
has already been burned by once — a fallback that reached for "the last button near the composer"
found "Use voice mode" and started recording. So the guard was written before the equivalent could
happen, not after:

- `uploadTrigger()` is **named-selector-only**, never guessed. Finding an input is harmless; clicking
  something to produce one is not, so a host whose trigger moves stops uploading rather than starts
  clicking around.
- `isPlausibleUploadTrigger` demands a positively upload-ish label, and unlike `isPlausibleSubmit` it
  refuses an *unlabelled* element too. The send check tolerates those because plenty of real send
  buttons are icon-only and a miss falls back to pressing Enter. There is no equivalent fallback
  here, and a miss costs a shortened paste — so the asymmetry is deliberate.
- The trigger is only clicked when a result genuinely needs uploading and `fileInput()` came back
  null. On the hosts that keep an input in the composer, nothing is ever clicked.

The user then sent claude.ai's "+" menu, which is the useful counter-example. It contains
`data-testid="add-menu-upload-file"` — "Add files or photos", ⌘U — that looks exactly like the thing
Gemini needed, and wiring it would have been worse than doing nothing. claude.ai's input
(`data-testid="file-upload"`) is already in the DOM at rest, so there is nothing to reveal, and that
menu item opens the *operating system's* file picker: a native dialog no page can drive and nothing
here can dismiss, left in front of the user while the upload fails anyway. The rule that came out of
it — a trigger is only worth naming when it materialises an `input` in the DOM — is now in CLAUDE.md
with a test pinning claude.ai as declaring none.

That exchange also checked something worth checking: the pasted menu uses `data-cds` / `base-ui`
markers, which looked like a newer design system than the captured transcript. It is not — the
existing fixture already carries fifteen `data-cds` attributes, so the claude.ai selectors are
current rather than stale.

Two smaller things fell out of the Gemini work:

- **Dismissal toggles the trigger rather than pressing Escape.** Escape in a chat UI can clear a
  draft or close something unrelated. Clicking the trigger again is precise — but only when
  `aria-expanded` still says open, because a menu that closed itself on file selection would be
  *reopened* by a blind second click.
- **The confirmation scope had to stop being derived from the input.** `chipScope` walked up from the
  file input, which is fine when the input lives in the composer. Gemini's lives in an overlay that
  is torn down when the menu closes, so that scope would be an orphaned subtree and the upload could
  never be confirmed. It is now walked from the composer and passed in explicitly.

### Host selectors, all from captures, and no guessing where there was no capture

Both new selectors came out of DOM already in the repo or in the user's message, per the house rule:

- perplexity.ai — `<input multiple accept=".bash,…,.md,…" type="file" style="display: none;">`, in
  the composer toolbar and present without opening the "Add files or tools" menu. No id, no test id,
  so the `accept` list is the most specific thing about it.
- claude.ai — `<input id="chat-input-file-upload-bottom" data-testid="file-upload" …>`, which was
  already sitting in `claude-transcript.ts` and had never been used.

ChatGPT came last, from a one-line console query rather than a DOM paste, and returned the most
interesting answer of the four: **four** file inputs at rest, three of them image pickers
(`#upload-photos`, `#upload-camera`, `#upload-media-files`). The usable one is `#upload-files`, which
carries no `accept` attribute at all.

That retroactively justifies `acceptsFile`. It was written against a hypothetical avatar uploader —
"an input that would refuse the file, usually an `accept` list for images" — as a guard for a case
nobody had seen. chatgpt.com has three of them sitting beside the right one, so a guess by proximity
alone had a one-in-four chance of attaching a markdown file to a camera input and silently getting
nothing. The named selector leads with the id; the filter is what makes the fallback safe.

### `accept` is a filter, and it is checked twice

`guessFileInput` skips an input whose `accept` would refuse the file, which is mostly how an avatar
picker (`image/*`) gets ruled out. `attachFile` then checks again at the point of use.

That repetition is deliberate and is the `isPlausibleSubmit` lesson applied early rather than after a
user gets bitten: the guard originally lived only in the guessing path, and what actually went wrong
was a hand-written *adapter* selector matching a microphone. Perplexity's `fileInput` list ends in a
bare `input[type="file"]` for exactly the same reason — so the check has to sit where the file is
handed over, not where the element was found.

### Attach before typing

Ordering, decided once and worth writing down: the upload goes first. A failed upload then leaves the
composer untouched and the fallback has an empty box to paste into, instead of needing to clear a
half-written turn.

---

## Naming what goes up

### The filename threw away the only thing that identified it

Found by the user, testing on chatgpt.com: reading `漢検漢字辞典漢字.csv` produced an attachment
called `webmcp-fs_read-c2.md`. That name was mine and it was wrong. It was chosen on the reasoning
that the body is not a byte-for-byte copy of the file — it carries the daemon's `path (N bytes)`
header — so naming it after the source would overstate what it is. True, and irrelevant next to the
fact that the name is the *only* thing in the turn identifying which file was read.

**First fix:** `webmcp-c2-漢検漢字辞典漢字.csv.md`.

- **The source name is sanitised as a filename, not as an identifier.** Reusing `safeName`, which
  strips everything outside `[A-Za-z0-9_-]`, would have rendered that name as a row of dashes and
  lost precisely the information being added. The rule is instead to remove what a filesystem or an
  uploader cannot take — separators, control characters, the Windows-reserved set — and keep every
  other character as the user wrote it. Only the basename is used, so a path separator can never
  reach the uploader.
- **Confirmation moved off the filename onto a separate short `marker`.** This is the part that would
  have been a real bug rather than a cosmetic one. Confirmation works by looking for the filename in
  the page — and the conversation now almost certainly contains the source filename already, because
  the user just asked for that file by name. Matching it would confirm an upload that never happened
  and send a turn claiming an attachment it does not have. The marker (`webmcp-c2`) cannot appear
  naturally, and being short it also survives a chip that truncates. A regression test plants the
  source filename in the scope and asserts the upload is *not* confirmed.

### "But is it necessary to add .md at the end?"

The user's next question, and the answer was no. The two reasons given for the suffix did not survive
being checked:

- *"Every host's `accept` list takes `.md`"* — true, and irrelevant, because they take the real
  extension too. ChatGPT's `#upload-files` and claude.ai's input have no `accept` at all; Perplexity's
  and Gemini's both list `.csv`, `.json` and `.ts`. What they do **not** list is `.zig`, `.svelte` or
  `.log`. So `.md` is an escape hatch for exotic extensions, not a rule for every file.
- *"The body is a result document, so `.csv` would be a lie"* — true, and self-inflicted. The body
  was only "a result document" because `fs_read` prefixes `path (N bytes)`. That line is written for
  a result the model reads *in the message*; inside an uploaded file it is corruption — a CSV gains a
  bogus first row and a JSON file stops parsing.

So the constraint got removed rather than worked around. `ToolContext.canAttach` tells a tool which
kind of output it is producing, and `fs_read` returns the bare file when the answer is "this is going
up as a file". Nothing is lost: the path and the byte count are already in the covering message and
in the attachment's own name. Verified live — the same read went from 362,918 characters to 362,890,
which is exactly the file.

The attachment is now `webmcp-c2-漢検漢字辞典漢字.csv`, `text/csv`, holding the file and nothing
else. `.md` is appended only when `acceptsFile` says the host would refuse the real extension, and
the covering message is rewritten to match so it never names a file that is not the one attached.

### The daemon tests had been running against a NaN budget

Found while writing a test for the `fs_list` naming fallback, which refused to attach anything.
`testConfig` in the test helpers builds a `Limits` literal by hand and had never gained
`maxAttachBytes`. That should have been a type error, and was not: the helper is
`testConfig(root, overrides: Partial<Config> = {})` and returns `{...literal, ...overrides}`, and
TypeScript accepts the spread of a `Partial<Config>` as capable of supplying the missing key.

So every daemon test with `canAttach` had `Math.max(4096, undefined)` — `NaN` — as its budget. The
`fs_read` cases passed anyway, for the wrong reason: `NaN` comparisons are all false, so the reader
never hit its cap and the whole file came back, which looks exactly like the intended behaviour.
`fs_list` truncates instead of paging, and `sliceBytes(body, NaN)` returns an empty string, so it
came back too small to attach — which is what exposed it. Production was never affected; `config.ts`
parses the key with a default, and the live probe runs were correct throughout.

The lesson is about the helper rather than the feature: a `Partial<T>` spread turns a required field
into an optional one silently, so a hand-built config in test helpers is not type-checked the way it
appears to be.

## Smaller things

### The probe was truncating its own output

`scripts/probe.mjs` is documented as the way to tell "the daemon is broken" from "the content script
cannot find the DOM", and it called `process.exit()` immediately after writing the result. On a pipe
that truncates the write. The first live measurement of the single-line fix reported 65,600
characters for a file that was actually returning 200,000 — a number close enough to the expected
65,536 to have been believed.

**Fix:** set `process.exitCode` and let the socket close drain the write. The probe also now prints
`[webmcp: N chars, marked for upload as …]` instead of dumping a megabyte of body into the terminal.

### The preamble had to be told

A model shown a `webmcp-result` block whose body is three lines of note will summarise the note. The
preamble now says a too-large result arrives as an attachment and that the attachment is the content,
and `renderAttachedResult` repeats it in the block itself.

### Test timing made injectable

The give-up path waits ten seconds for the host to show a chip. Written literally, that one test took
longer than the entire extension suite. `attachFile` takes an optional `{ timeoutMs, pollMs }`, and
the suite is back to ~1.2s.

---

## Running the same command twice, and never running it at all

Reported from a live session after everything above had landed: a call aborted part-way, and coming
back to the chat later made the daemon run the command again. The user asked for a 30-second
timestamp check on picked-up calls.

The timestamp is the right instinct and the wrong mechanism. The actual defect is that
de-duplication lived only in memory: `handled` is a `Set` on the scanner, so a page reload, an
extension reload or a crashed content script empties it, and the next scan finds a transcript full of
syntactically perfect tool calls with nothing marking them as already dealt with. Age is a proxy for
the thing that matters, which is *"did this appear while we were watching?"*

**Fix, in two parts.** `CallGate.beginScan` writes off everything visible in the first five seconds
after attach — marked handled, never dispatched. The window is not a single first scan because these
are SPAs and the first scan can land before the turns hydrate; it disarms once there has been
something to seed, or once the window closes, so a brand-new chat does not stay armed and swallow the
model's first real call. Behind that, `MAX_CALL_AGE_MS` is the 30 seconds that was asked for, for
what seeding cannot see: a backgrounded tab whose timers were throttled, a scan blocked while
something else ran.

Two things that were nearly got wrong:

- **Age is measured from the block's last *edit*, not from when it first appeared.** Backwards, this
  drops calls that streamed slowly — which are the long, interesting ones. There is a test that
  streams a call over 100 seconds and asserts it still runs.
- **Page timestamps are not used, and checking one settled it.** The user asked whether a Perplexity
  assistant turn carries a timestamp, and sent one to look at. It does not: no `<time>`, no
  `datetime`, no `data-time*`, and its entire attribute set is `aria-label, class, data-renderer,
  data-workflow-final-text, data-workflow-text-footer, dir, lang, style, type`. The only timestamp
  Perplexity renders is a hover-revealed span on the *user* bubble — `23 Aug, 01:17`, no year, no
  timezone, on the one kind of turn `touchesUserTurn` exists to refuse reading, and page-controlled
  text that a prompt-injected page could write anything into. Observation time inside the content
  script cannot be lied about, and is the only clock available anyway.

The rules moved into `content/gate.ts` so they could be tested against a fake clock, the same reason
`turnsToScan` was extracted for the scan-cost test. Eleven tests, none of which needs a DOM or a real
thirty seconds. The one that matters most is the first: a call on screen at attach time returns
`history`, not `run`.

### "So there's no way to know if it's 30 seconds or 2 days old?"

The user's follow-up, and the answer from the page is no — verified rather than assumed. A Perplexity
assistant turn carries no time signal at all: no `<time>`, no `datetime`, no `data-time*`, and its
whole attribute set is `aria-label, class, data-renderer, data-workflow-final-text,
data-workflow-text-footer, dir, lang, style, type`. The only timestamp Perplexity renders anywhere is
a hover-revealed span on the *user* bubble — `23 Aug, 01:17`, no year, no timezone, on the one kind of
turn `touchesUserTurn` exists to refuse reading, and page-controlled text a prompt-injected page could
write anything into.

But the question exposed that age was the wrong thing to want. The page cannot date a call; *we* ran
it, so we can date our own action, and "we already did this" is a stronger answer than "this looks
old". `content/history.ts` now records every dispatch in `chrome.storage.local`, keyed by thread path,
loaded before the first scan. Three decisions in it:

- **Recorded at dispatch, not at completion.** A call that was sent and then abandoned — the daemon
  dropped, the tab closed — is precisely the one that must not be retried, and it is the case the bug
  was reported for.
- **Keyed by thread, pruned after a week.** Another conversation's calls must not be written off, and
  the store must not grow forever.
- **Degrades to in-memory, never throws.** An orphaned content script throws on every `chrome.*`
  call; losing the record costs a forgotten call, while throwing would take out the scanner.

This also closes the tail case in seeding, which is worth admitting: the 5-second window disarms on
time, so a page slow enough to hydrate after it would have replayed its transcript anyway. Seeding is
the heuristic and the stored record is the fact; neither replaces the other, because the record is
keyed by a URL a brand-new chat does not have yet.

### "But what if the AI runs the same command one more time?"

Asked immediately after the record landed, and it was the right question to ask: the record as first
written would have been worse than the bug it fixed.

A call is keyed by `hash(call.raw)` — the text of the block. Two things produce identical text: the
same message being re-read after a reload, and the model genuinely emitting the same call again. The
only thing separating them is the `id` field, and the preamble had never told the model that ids must
be new. A model that writes `"id": "1"` every time would have had real repeats dropped — in-session
already, and for a *week* once the record persisted them.

Two fixes, because it is two problems:

- **State the contract.** The preamble now says: give every call a new id, counting up; reusing an id
  means "this is the same call as before" and the repeat is ignored. That rule was being relied on
  without ever being written down, which is the same failure as the composer selectors — a rule that
  lives only in the implementation.
- **Bound the record.** `REPLAY_WINDOW_MS` (60s) is how long the stored record has a say. A
  transcript replays immediately, so that is when the record is needed; an hour later a matching call
  is the model asking again, and the record forgets the old dispatch rather than refusing. Generous
  enough for a slow page hydrating well after the 5-second seed window, short enough that no
  mid-conversation repeat falls inside it.

The in-session behaviour is unchanged and pre-dates all of this: identical id *and* identical
arguments is read as one call and run once. That is the correct reading of an id — but it was worth
finding out that it had never been explained to the model.

### Complaining about a block the model had not finished writing

Found while chasing a report that turned out not to be a bug — a big `fs_write` looked like it had
been picked up half-written, and was actually just sitting on an approval prompt the user had missed.
The scanner was right. The error path was not.

`collectFromBlocks` takes `includeUnclosed` so a caller that *infers* closedness from the DOM can
hand over half-written blocks and apply its own settling window to a call. That flag also let those
blocks reach the error path — and half a JSON object never parses. So every intermediate state of a
long `fs_write` looked like a malformed tool call and drew its own "your tool call could not be read"
reply. A model writing a big file slowly would be interrupted several times over, each complaint
keyed on a different partial hash so de-duplication could not collapse them.

**Fix:** an error is only reported for a block that is `closed`. An unterminated block is not
malformed, it is not finished. The extension additionally settles errors through the same gate as
calls, which covers the case where `isStreaming()` is wrong — Perplexity's is still a guess — and the
block is therefore treated as closed while it is in fact still growing.

Worth noting what let this survive: the guard's own comment said "The guard that matters: an
unterminated block is still being typed", six lines above a branch that ignored it. The rule was
written down and then only half applied.

A note for later: `packages/extension/tsconfig.json` has `"include": ["src", "build.mjs"]`, so the
test files are never type-checked — vitest transpiles them with esbuild, which strips types without
checking them. Removing `admitError` left a test calling a method that no longer existed, and
`npm run typecheck` was perfectly happy; only running the suite caught it.

A skipped call is also announced now — `stale` reports to the popup, and the diagnostics report
carries a `skipped` count. Silence here is indistinguishable from a daemon that is not connected.

---

## What I'd do differently

- **The first answer to the user was confidently wrong in one specific.** "It is already capped at
  64 KiB, so the freeze is about the insertion path" was asserted from reading `config.ts` and the
  call site, not from reading `readLineRange` to the end. The cap was real and the branch that
  ignored it was fifteen lines further down. Reading a limit's *definition* is not the same as
  reading its enforcement, and a comment claiming the exception is intentional is exactly what should
  have slowed me down rather than sped me up.
- **The one-line file should have been written as a test on the day paging was fixed.** The previous
  session rewrote `readLineRange` and covered the interesting multi-line cases thoroughly. The
  degenerate input of a line-oriented reader is a file with one line, and it was not on the list.
- **jsdom's gaps were found by probing, which was the right move but a slow one.** `DataTransfer`
  does not exist there and `input.files` has no setter, discovered by writing a throwaway test that
  asserted its own findings into a failure message. Worth doing before designing the tests rather
  than after writing them.
- **Two of the session's fixes came from a user question, not from a test.** The `.md` suffix and the
  `webmcp-fs_read-c2` filename were both mine, both defended once, and both wrong. The pattern in
  each: a constraint I had introduced (the header line in the body) was being treated as a fact about
  the world rather than as something I could remove. Worth asking, of any constraint being worked
  around, whether it is load-bearing or self-inflicted.
- **The rule was written down and then half applied.** The comment above `collectFromBlocks`'
  unclosed check says "an unterminated block is still being typed" — six lines above a branch that
  handed unterminated blocks to the error path anyway. Writing a rule in a comment is not the same as
  applying it everywhere it holds, and the comment made the code *look* considered.
- **A guard added late made an old behaviour permanent, and I nearly shipped it.** Persisting the
  handled-call record extended in-session de-duplication to a week — including its blind spot, where
  a model that reuses call ids emits byte-identical text for a genuine repeat. The user caught it by
  asking the obvious next question. Any change from "for this session" to "for a week" deserves a
  pass over what the old scope was quietly forgiving.

## Open items

- **Nothing here has run against a live page.** Every mechanism —
  `input.files = dataTransfer.files` from an isolated world, the `change` event being honoured, the
  chip appearing with the stem in it, and on Gemini the overlay actually appearing after the click —
  is verified only against jsdom with stubs and against the captured DOM. The daemon half was verified end to end with the probe. The browser half needs a real
  session before this can be called confirmed at both ends, and the confirmation heuristic is the
  part most likely to be wrong.
- **The insertion path itself is unchanged.** This session removed the *large* pastes; it did not
  make pasting 64 KiB cheaper. Feeding the `ClipboardEvent` path instead of `execCommand` for large
  text is still the untested hypothesis from the opening exchange, and it would help the hosts with
  no upload control.
- **`exec_run` output still uses `exec.maxOutputBytes` (32 KiB) and never attaches.** A large
  `git diff` is the obvious next candidate; it was left out to keep one budget concept in play rather
  than three.
- **Multi-part results are never attached.** Only a single-part text result is marked, because the
  renderer joins parts and attaching "the body" would change what the model is shown. Downstream MCP
  results are the case that will eventually want this.
- **ChatGPT's composer was never captured.** Its upload input is now pinned from a console query, but
  the composer and send-button selectors are still written from knowledge. That is the host most
  likely to break next, and the widening fallback for `fileInput` starts from a composer those
  selectors have to find first.
- **No fixture pins any host's upload chip.** The confirmation logic — the part most likely to be
  wrong — is tested against a synthetic chip on every host. When a real one is captured, those tests
  should be rewritten against it.
- **Gemini's menu behaviour after a file is chosen is a guess.** Whether it closes itself, and
  whether the chip lands inside the composer scope, are both unobserved. The dismissal is written to
  be correct either way; the confirmation scope is not proven.
- **The extension's test files are not type-checked.** `packages/extension/tsconfig.json` has
  `"include": ["src", "build.mjs"]`, and vitest transpiles tests with esbuild, which strips types
  without checking them. Removing a method left a test calling one that no longer existed and
  `npm run typecheck` passed. Left alone deliberately — widening the include may surface a batch of
  unrelated errors, and that is its own change.
- **`isStreaming()` on Perplexity is still a guess**, and it now carries more weight than it did:
  the settling window a block gets, and therefore whether a half-written block can be judged, both
  depend on it. The captured thread was idle, so there is still nothing pinning it.

# 2026-08-27 — First implementation, and four host adapters learned the hard way

Went from an empty repo (just `CLAUDE.md`) to a working end-to-end system: a local daemon that owns
all execution, a Chrome MV3 extension that bridges browser chat UIs to it, and tool calls actually
running against the filesystem on all four supported hosts.

**Final state:** 296 tests green (142 daemon, 154 extension), ~5,000 lines of source, ~3,600 lines of
test, 6 verbatim DOM fixtures.

---

## What got built

An npm workspace, Node + TypeScript throughout.

- **`packages/protocol`** — the wire contract *and* the text tool-call protocol (fence extraction,
  call parsing, preamble/result rendering). Shared by both halves, which is why the fence parser is
  unit-tested by the daemon's suite despite only the extension using it.
- **`packages/daemon`** — the only trust boundary. Workspace jail, `fs_read/write/list/stat`,
  `exec_run`, MCP aggregation, approval policy, WebSocket server.
- **`packages/extension`** — service worker (socket + token), content script (DOM + per-host
  adapters), popup (pairing + approvals + diagnostics).

Plus tooling that turned out to matter more than expected: `scripts/probe.mjs` (drive the daemon by
hand, no browser), `scripts/diagnose-page.js` (paste into a page console, dump what each selector
matches), `scripts/make-icons.mjs` (generate the toolbar icon).

Verified working end to end: filesystem reads auto-approved inside the jail, writes and exec gated on
human approval, a real downstream MCP server aggregated alongside a deliberately broken one, and
`fs_read`/`fs_write` executing from ChatGPT, claude.ai, Perplexity and Gemini.

---

## Part 1 — the daemon

This half went smoothly, and the tests earned their keep immediately. Five real bugs, all found by
writing the test rather than by reading the code.

### `openWrite` wrote through symlinks despite documenting that it refused to

`resolveForCreate` calls `realpath` and dereferences the link *before* `O_NOFOLLOW` ever sees it. So
`fs_write alias.txt` would silently overwrite the link's target while the approval prompt said
"alias.txt".

Not a jail escape — the target was still inside the workspace — but an integrity problem: the human
approved a different action than the one that happened.

**Fix:** writes are now held to a stricter rule than reads. A read may follow a link that resolves
inside the jail; a write requires the requested path to contain **no symlinks at all**. Implemented by
comparing the literal joined path against the resolved one — if they differ, something along the way
is a link.

### The exec allowlist ran *after* the approval prompt

The user was asked to approve `sh -c echo pwned`, clicked allow, and *then* got refused because `sh`
isn't allowlisted. Backwards, and actively harmful: it teaches the user that approving is harmless.

**Fix:** added a `Tool.validate` hook that runs before `Policy.decide`. Anything refusable without
side effects is refused before a human is bothered. An approval prompt now always describes something
that would actually run if allowed.

### Output over the hard cap was discarded entirely

A command that blew the memory ceiling got killed and the buffered output *thrown away* — the user
received only `[webmcp: output limit reached]` and none of the actual output.

**Fix:** keep the prefix, trim to the remaining budget, then let the normal truncation do its job.

### The duplicate-call-id check could not fire

`inflight` was only populated *after* the approval resolved. So two calls sharing an id both slipped
past the check while the first sat in front of a human, and each raised its own prompt.

**Fix:** claim the id immediately, before the approval wait. Two bonuses fell out: `cancel` now works
on a call that hasn't started, and `MAX_INFLIGHT` correctly bounds how many prompts a page can queue.

### `--print-token` demanded a workspace

It loaded the full config before printing, so it failed with `no workspace configured` on a machine
that hadn't set one up — even though showing the token has nothing to do with the filesystem grant.

**Fix:** resolve just the state directory and print. Also made the startup banner print the token
**every** run, not only the first — hiding it afterwards just forced a second command. Added
`--hide-token` for screensharing rather than imposing the old behaviour on everyone.

---

## Part 2 — the extension, which is where the real time went

Everything above was findable from first principles. The browser half was not. Four hosts, four
completely different DOM structures, and **essentially nothing transferred between them.**

The turning point was asking for real DOM captures instead of guessing. Every fix below came from a
verbatim capture, and not one of them was guessable in advance.

### The manifest was the first blocker, and my error message lied about it

"Diagnose this page" reported *"no WebMCP content script in that tab — reload the chat page"*, so we
spent a round reloading pages. The content script was fine. The extension had **no
`host_permissions` for the chat sites** — a declarative `content_scripts` entry injects the script but
does not grant access to the tab, which `chrome.tabs.sendMessage` needs.

Worse, that one message was the response to three different situations: genuinely absent, host
unsupported, and permission denied. It named the only one that wasn't happening.

**Fixes:** added the host permissions; added `scripting` so the worker can inject `content.js` itself
and retry (removing the "reload in the right order" trap entirely); registered the message listener
**unconditionally at module scope** so an unsupported host answers `no WebMCP adapter claims <host>`
instead of looking dead; gave each cause its own message.

Also: there was no toolbar icon, so the button was a grey placeholder — a large part of why it was
hard to find at all.

### A wrong language label could veto a valid call

The model emits ` ```webmcp `, but ChatGPT's highlighter relabels blocks it thinks it recognises. The
call came back tagged `json`, my code read the label, skipped anything that wasn't exactly `webmcp`,
and a perfect call became invisible.

I *had* a shape-sniff fallback for this and it was useless: it only ran when the label was **absent**.
A *wrong* label beat it.

**Fix:** deciding what a block is now belongs to the parser, not to a regex in the DOM layer.
`collectFromBlocks({ acceptMislabelled: true })` accepts any block whose body parses as a real tool
call, at the same bar as `parseToolCall`. This turned out to be load-bearing on **three** of the four
hosts — none of them exposes the language in a class:

| host | where the language actually is |
|---|---|
| chatgpt.com | header *text*, `<div>webmcp</div>` |
| gemini | header *text*, "Code snippet" / "Markdown" |
| perplexity | `<figcaption>` *text*, "text" |
| claude.ai | nowhere |

### "Unclosed" was a hard veto over a guess

Once markdown is rendered the backticks are gone, so the content script can't *see* a closing fence —
it infers it ("still streaming ⇒ last block is still growing"). If a host's stop-button selector
matches something persistent, `isStreaming` sticks true, the last block is permanently "unclosed", and
the call never fires. Deadlock.

I'd made an inference behave like an observation.

**Fix:** split the two cases. Text-derived blocks *observed* whether a terminator was there — unclosed
is still refused outright. DOM-derived blocks only *inferred* it, so instead of vetoing they require a
longer settling window (2.5s of byte-identical content). The safety property survives: half-typed JSON
doesn't parse at all, and the only thing left to rule out is a valid-but-incomplete prefix like
`{"tool":"fs_write"}` sitting motionless — tokens arrive far faster than that.

Related trap: after the last token there are no more mutations, so nothing would ever have woken the
scanner to re-check a settling block. Added a self-scheduled rescan, plus a slow poll alongside the
MutationObserver (these are SPAs; the node you attach to can be swapped out and then fires nothing
forever).

### Turn discovery was scoped to the conversation root

`assistantTurns(root)` searched *inside* whatever `conversationRoot()` matched — a layout guess. When
it matched the wrong wrapper, `assistantTurns` returned nothing, which looks exactly like "the model
hasn't replied yet". **One stale layout selector silently disabled the entire product**, and my
fallback masked it rather than surfacing it.

**Fix:** turns come from the document. The root is now only a MutationObserver target.

### The worst one: the extension would run the example out of its own instructions

claude.ai's capture revealed this. **User turns contain rendered code blocks**, and two of them hold
syntactically perfect tool calls the model never made:

- the injected preamble's *worked example*;
- every tool result pasted back as a user message.

My fallback widened to `document.body` on the reasoning that "a superset is harmless, dedup prevents
repeats." Wrong. Firing once is enough to be wrong — the action already happened.

Then Gemini showed a *worse* variant: it renders user turns as plain-text paragraphs with the literal
``` fences **left intact**, so the *text* scanner finds a complete, closed, valid call. No code block
required. Perplexity does the same with a `whitespace-pre-line` span.

**Fix:** `touchesUserTurn` filters turns in both the adapter wrapper and `scan()`; it rejects anything
that merely *contains* a user turn (Gemini's `.conversation-container` wraps both sides and is
therefore unusable as a turn selector); and the fallback returns **nothing** rather than widening.
Returning nothing is visible in the diagnostics — guessing wide is a silent wrong action.

The preamble's example now also points at `path/to/file.txt` instead of a real file, so if the boundary
ever slips the result is a loud `jail_violation` rather than a quiet successful read.

The user markers are wildly inconsistent and **Perplexity has none at all** — no data attribute on the
bubble, so the list keys on the Tailwind group name `[class*="user-bubble"]`:

| host | user marker |
|---|---|
| claude.ai | `[data-perf-row="human"]` |
| chatgpt.com | `[data-message-author-role="user"]` |
| gemini | `<user-query>` |
| perplexity | **nothing** |

### The extension clicked the microphone

Reported live on Perplexity. **Not one of the four hosts has a plainly-present send button when the
composer is empty:**

- Gemini renders none at all;
- Perplexity renders none in the zero state — "Use voice mode" occupies that slot — and a `disabled`
  one mid-thread;
- claude.ai renders one `disabled` inside an `inert` wrapper.

My fallback was "last visible button near the composer". On Perplexity that is **"Use voice mode"**; on
Gemini, **"Dictate"**. It doesn't fail politely — it starts recording the user.

Worse, my first fix was in the wrong layer. I put the deny-list in the *heuristic* only, but on
Perplexity the mic wasn't guessed — it was matched by a hand-written adapter selector,
`button[aria-label*="Submit" i]`. **A guard covering only the guessing path does not cover the path
where someone guessed in advance and wrote it down.**

**Fix:** `isPlausibleSubmit` runs in `compose.ts` immediately before the click, so it covers every
route a button can arrive by. It vetoes on **structure before wording** — `aria-pressed`,
`aria-haspopup`, `aria-expanded` are disqualifying on their own, which is what catches Perplexity's
Search/Computer mode toggles that carry no `aria-label` at all (no word list would have rejected
"Computer"). Checked on the element *and up to two ancestors*, because Gemini puts the ARIA on the
custom-element wrapper (`<gem-icon-button aria-haspopup><button>`). `guessSubmitButton` now returns
`null` rather than guessing; Enter is the safe universal fallback and every host accepts it.

Also: send is now *verified* rather than assumed — clicking the wrong element looks identical to
clicking the right one, so it checks the composer actually emptied and falls back to Enter if not.

### Chrome's internal wording leaked into the conversation

Perplexity's capture contained a tool result reading `status: error / Extension context invalidated.`
That's what happens when the extension is reloaded while a chat page is open — the old content script
keeps running with a dead `chrome.runtime`. My code caught the error and forwarded the raw message,
which tells the model nothing and the user less.

**Fix:** recognised specifically, replaced with *"WebMCP lost its connection because the extension was
reloaded. Reload this page, then ask again."*, and the scanner **detaches** — nothing it does
afterwards can succeed. Previously it kept scanning and would produce that error for every subsequent
call.

### Smaller ones, all found by tests

- **`el.tabIndex` was the wrong check** for skipping Quill's hidden second contenteditable. The
  property's default for a `contenteditable` div isn't consistently specified across engines, so it
  rejected legitimate composers. Tests the `tabindex` *attribute* now.
- **`setText` gated on `el.isContentEditable` alone.** That's the computed value; it disagrees with the
  attribute in both directions. Accepts either now.
- **The paste fallback threw** when `DataTransfer` was unavailable, killing the whole delivery. Now
  degrades to a reported `insert_failed`.
- **`execCommand` was unguarded** — it's deprecated; if an engine drops it, that threw too.
- **A malformed selector took down the whole content script.** `firstMatch`/`allMatches` swallow it
  now; one bad selector in one fallback list shouldn't be fatal.
- **The fixed 3-parent walk for the send button was arbitrary** — Gemini's is a cousin several levels
  up. Widens one ancestor at a time, nearest hit wins.
- **The content script's message listener never called `sendResponse`**, so the worker's
  `tabs.sendMessage` promise rejected and the popup blamed a missing content script.

---

## What I'd do differently

**Ask for the real DOM immediately.** I wrote all four adapters from memory first and every single one
was wrong in a way that mattered. Four rounds of "still doesn't work" could have been one round of
"paste me the DOM". The moment captures arrived, each host took one pass.

**Build the diagnostic before the feature.** "Nothing happened" was the failure mode for several
rounds, and it was indistinguishable across five different causes. The Diagnose button — which prints
turn count, composer, send button, streaming state, and *what the fence scanner currently sees* —
should have existed from the start. Debug-time observability was worth more than any single fix.

**Distrust my own error messages.** Twice I sent us looking in the wrong place because one message
covered several causes. `"no content script in that tab"` and `"Extension context invalidated"` both
described a real condition and pointed at the wrong remedy.

**Put guards at the point of action, not the point of decision.** The pattern repeated three times:
the exec allowlist checked after the prompt, the mic deny-list in the heuristic instead of at the
click, the duplicate check before the state it guarded existed. Guard where the thing actually
happens.

**Fixtures must be faithful, including the parts that look like noise.** Twice I "tidied" a capture and
broke the test's meaning — flattening away an `aria-haspopup` wrapper the thumbs buttons really sit
inside, and mis-escaping backticks so a hazard test passed for the wrong reason. The Tailwind soup and
generated class hashes stay in.

---

## Open items

- **`isStreaming` on Perplexity** is still a guess — the captured thread was idle. Fails safe: a false
  positive only lengthens the settling window.
- **No packaging** — load-unpacked only, no store listing, no signing.
- **The approval UI is minimal.** No history, no way to review or revoke standing allows from the popup
  (`Policy.revoke` exists but nothing calls it).
- **Downstream MCP servers are untested beyond a hand-rolled fixture server.** Aggregation, namespacing
  and degrade-not-block are verified; no real Notion/Figma server has been connected.
- **The daemon has no rate limiting.** `MAX_INFLIGHT` bounds concurrency per connection, nothing bounds
  calls over time.
- **`exec_run` has no output streaming** — a long-running command is silent until it exits or times out.

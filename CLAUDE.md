# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keep README.md current — every time

`README.md` is the user-facing half of the documentation and it goes stale silently, because nothing
compiles it and no test fails when it lies. Two claims drifted before anyone noticed: it listed three
supported hosts after gemini.google.com shipped with an adapter, a manifest entry and a fixture, and
it said the daemon "prints a pairing token on first run" long after that was changed to every run.

So: **any change a user could notice belongs in `README.md` in the same pass as the code.** Not a
follow-up, not "later" — the same change. Concretely, update it when you touch

- a CLI flag, its name, or its default (`--set-workspace`, `--hide-token`, `--config`);
- a config key, its shape, or its default (`workspace`, `workspaces`, `port`, `exec.allow`, `limits`);
- where anything on disk lives (the `.webmcp/` directory, the token, the allowlist);
- what needs a restart versus what reloads live;
- the set of supported hosts, or anything visible in the popup;
- any security-relevant behaviour a user relies on — what prompts, what is auto-approved, what the
  jail refuses, what a standing "always allow" covers.

Two rules that come from getting this wrong:

- **Verify claims against the code, not against memory.** Both stale lines above read as plausible.
  Grep for the constant, or run the thing — the empty-`exec.allow` behaviour and the documented config
  example were both checked by booting a daemon, and that is the standard.
- **Explain every key you show.** A config example with keys nobody defines invites a reader to guess.

`README.md` is the overview and stays short: it defers to this file for architecture, invariants and
the full command reference. When a detail is too deep for it, put the detail here and leave the
README a correct one-liner that points across — never a wrong one, and never silence.

## Devlog format

One file per working session in `devlog/`, named `YYYY-MM-DD-kebab-slug.md`. Write it when a session
ends, or when asked. The format below is the house style — follow it rather than re-deriving it from
the existing entries.

```markdown
# YYYY-MM-DD — Short title, and the thing that made the session interesting

Two or three sentences: what the session set out to do, and what it actually turned into.

**Final state:** N tests green (X daemon, Y extension), up from the previous entry. Diff stats, and
new files by name.

---

## <A section per theme, named for the thing, not the phase>

Prose. Then a `### heading` per bug or decision, each one: what broke, why it mattered, **Fix:** what
changed. Quote the actual selector, flag, or error where there is one.

---

## What I'd do differently

The honest part. Process failures, not just code ones.

## Open items

What is knowingly unfinished, and why.
```

What earns a place, in rough priority order:

- **A bug and the reasoning that produced it.** Not "fixed X" — what the wrong assumption was, what it
  cost, and what made it visible. An entry that only lists changes is a changelog; `git log` is
  already that.
- **Anything a test caught that reading could not**, and anything a test *failed* to catch. Both are
  the useful signal.
- **Decisions with a rejected alternative.** Record what was not done and why, because that is the
  part no diff shows.
- **Who found each problem.** "The user hit this in five minutes" is data about where the verification
  was thin, and it belongs in the log rather than being smoothed over.

Two habits that keep these worth reading:

- **Verify the numbers before writing them.** Test counts, diff stats and dates go in from a command
  run in that session, never from memory — the same rule as `README.md` above. One stat was wrong in
  the first draft of the 2026-08-29 entry because `git diff --stat` counts only tracked files.
- **Write the failures at full strength.** The value is concentrated in what went wrong; a devlog that
  reads like a victory lap is one nobody consults later. If a fix was a second attempt, say it was.

## Status

First implementation has landed. Both halves build, and the daemon has a test suite covering the
jail, the fence parser, the exec allowlist, the approval flow and MCP degradation.

Layout — an npm workspace, Node.js + TypeScript throughout:

- `packages/protocol` — the wire contract *and* the text tool-call protocol (fence parsing, preamble
  and result rendering). Shared by both halves, which is why the fence parser is unit-tested by the
  daemon's suite despite only the extension using it.
- `packages/daemon` — `cli.ts` → `config` → `jail` → `registry` (`tools/fs`, `tools/exec`,
  `mcp/manager`) → `policy` → `server`. The only trust boundary.
- `packages/extension` — `background/` (socket + token), `content/` (DOM + adapters), `ui/` (pairing,
  approval UI and the workspace picker).

Adapter status — **all four hosts confirmed at both ends**, each pinned by a verbatim DOM capture in
`packages/extension/test/fixtures/`. When a host breaks, capture the new DOM into a fixture *first*;
every non-obvious rule below was learned that way, and none of them was guessable.

- **claude.ai** — fully confirmed, both ends. Composer (`[data-testid="chat-input"]`, TipTap), send
  button (`chat-input-send`, which exists but is `disabled` and `inert` while the composer is empty),
  streaming flags (`data-perf-row-streaming`, `data-is-streaming`), assistant turns
  (`[data-perf-row="assistant"]`) and the upload input (`[data-testid="file-upload"]`, always present,
  with no `accept` list) all pinned. The richest fixture of the four — it is the one that
  revealed the user-turn hazard.
- **chatgpt.com** — working. Assistant turn and nested-`<pre>` code block confirmed and pinned, as is
  the upload input: `#upload-files`, present at rest with **no `accept` attribute**, alongside three
  image-only pickers (`#upload-photos`, `#upload-camera`, `#upload-media-files`) that a
  proximity-based guess would have had a one-in-four chance of choosing. Still the least-confirmed of
  the four — the composer and send-button selectors are written from knowledge, not from a capture.
- **perplexity.ai** — fully confirmed, both ends. Composer (`#ask-input`, Lexical), answers
  (`[data-workflow-final-text]`, with the Copy/Share/thumbs row a *sibling*
  `[data-workflow-text-footer]`), code blocks (`<pre><figure><figcaption>` — the language label lives
  in the figcaption *outside* the `<code>`) and `button[aria-label="Submit"]` all pinned. The upload
  input is pinned too — an always-present `<input type="file" accept=".bash,…,.md,…">` in the
  composer toolbar, keyed on that `accept` list because it carries no id or test id. This is
  where the voice-mode click happened; a regression test asserts *no* button is clicked on the zero
  state. Only `isStreaming` is still a guess — the captured thread was idle.
- **gemini.google.com** — fully confirmed, both ends, and observed executing `fs_read` and `fs_write`
  end to end. Composer (`div.ql-editor`, Quill), conversation root, assistant turns
  (`<model-response>` → `<message-content>`), code blocks (`<code-block>` →
  `<pre><code data-test-id="code-content">`) and streaming (`aria-busy` on `.markdown-main-panel`) all
  pinned. Like Perplexity it renders **no send button** until the composer has text, and delivers via
  Enter. Its uploader is the odd one of the four: there is **no `input[type="file"]` in the DOM at
  all** until `button[aria-label="Upload and tools"]` is clicked, which builds a CDK overlay holding
  `<uploader>` and two identical `input.hidden-file-input` (accept list includes `.md`). Both states
  are pinned — `GEMINI_ZERO_STATE` for the absence, `GEMINI_UPLOAD_MENU` for the overlay. ChatGPT has
  its upload input pinned too (see above).

## Project Overview

WebMCP gives browser-based LLM chat UIs (chatgpt.com, claude.ai, perplexity.ai, gemini.google.com)
MCP tool access on
the user's machine: local filesystem reads/writes, shell commands, and any third-party MCP server
(Notion, Figma, …). It is two artifacts that ship together:

- **Chrome extension (MV3)** — injects a tool protocol into the chat page, watches the assistant's
  output for tool calls, feeds results back into the conversation.
- **Local daemon (Node/TS)** — owns all execution. Exposes built-in filesystem/exec tools *and*
  proxies downstream MCP servers, presented to the extension as one flat tool list.

## Architecture

```
[ page: chatgpt.com / claude.ai / perplexity.ai ]   ← untrusted
        │  content script: DOM read + write
        ▼
[ content script ] ──chrome.runtime──► [ service worker ]   ← broker, holds no authority
                                              │  ws://127.0.0.1:PORT
                                              ▼
                                        [ daemon ]   ← the only trust boundary
                                         ├─ built-in tools: fs, exec (workspace-jailed)
                                         └─ MCP client → notion / figma / … servers
```

### Three trust zones — get this right or nothing else matters

The page is hostile. Tool calls originate as *text the model typed into the DOM*, and any web page
the model reads can prompt-inject that text. A malicious page can also open its own
`ws://127.0.0.1:PORT` connection. Therefore:

- **All authorization lives in the daemon.** The extension is a transport, never a gatekeeper. Never
  let a message from the page widen the workspace root, add an allowlist entry, or skip approval.
  The workspace root *moves* at runtime (see below) and this rule still holds exactly as written:
  moving is a selection from a list the user wrote on disk, never a way to name somewhere new.
- **The daemon authenticates its client.** Origin headers on a WebSocket are not sufficient — pair
  the extension with the daemon via a shared token held in `chrome.storage` and required on connect.
- The daemon binds `127.0.0.1` only, never `0.0.0.0`.

### Security model: the workspace jail

The whole product promise is "it can only touch the directory I named." Enforce it in the daemon:

- Resolve every path argument with `fs.realpath` **first**, then check containment in the workspace
  root. Checking the raw string before resolution misses symlinks and is the classic escape.
- Re-resolve at use time, not just at validation time — a symlink can be swapped between the check
  and the `open` (TOCTOU). Prefer opening a handle and validating that.
- Exec runs with `cwd` = workspace root, `spawn(cmd, argv, {shell: false})` — never string
  interpolation into a shell. Keep a binary allowlist.
- Write and exec require explicit human approval in extension UI unless the user has allowlisted the
  specific shape. Reads may be auto-approved inside the jail.
- Downstream MCP servers are outside the jail by nature (Notion, Figma reach the network). Treat
  enabling one as its own consent decision, separate from the filesystem grant.

### Moving the workspace without restarting

`packages/daemon/src/workspace.ts` owns the live root. A `Workspace` is still immutable — a jail that
can be moved by whoever it contains is not one — so a switch builds a new one and swaps the
reference. Two routes, and both of them route the *grant* through the config file, which is the only
channel the browser cannot reach:

- `--set-workspace <dir>` writes `workspace` and unions `<dir>` into `workspaces`, then exits. The
  running daemon notices via a config watcher (and `SIGHUP`) and moves. This is how a **new**
  directory is granted.
- `set_workspace` on the wire, reachable only from the popup's picker, **selects** among the roots
  already in `workspaces`. It cannot add one.

Rules the implementation settled here, none of them optional:

- **A call is pinned to the jail it arrived under, before the approval wait.** `server.ts` reads
  `workspaces.current` once when the call is claimed and passes that `Workspace` through `validate`,
  `Policy.decide`, `alwaysLabel`, `allowAlways` and `registry.call`. Reading the live root at
  execution time instead means a switch while a prompt is open redirects the write: the human
  approved "write `config.json` in *project-a*" and it lands in *project-b*. A regression test pins
  this, and it fails if the pin is removed.
- **Standing allows are keyed by root.** `scopedKey(root, allowKey(...))`. The button has always read
  "Always allow `git` in *project*", so carrying the grant across a switch would be the daemon doing
  something other than what was clicked. Rules written before scoping carry no root, so they are
  dropped on load rather than guessed at — one extra prompt beats a grant applied to a directory
  nobody named.
- **Narrowing is free, widening is refused.** A subdirectory of a granted root is strictly less reach,
  so it needs no separate grant. The *parent* of a granted root is a widening and is refused, which is
  the case worth having a test for.
- **Resolve before comparing, exactly as the jail does.** `switchTo` realpaths the request first; a
  symlink inside a granted root pointing at an ungranted directory would otherwise pass a string
  check.
- **A config reload moves the root only when `workspace` itself changed.** The manager remembers the
  last value it read. Otherwise touching the file to add an MCP server yanks the user out of a root
  they picked in the popup. For the same reason `--workspace` is dropped on reload: it says where to
  *start*, not where to stay, and leaving it in would make a daemon started the documented way
  unmovable.
- **The watcher watches the directory, not the file.** Editors and `writeFile` replace the config
  rather than truncating it, so a watch bound to the old inode goes silent forever. A half-saved file
  parses as garbage; keeping the current config and waiting for the next write is right.
- **A move is broadcast to every session, not just the asker.** A stale root in a second tab's popup
  is a lie about what the tools can reach.

Rules the implementation settled that were not obvious up front:

- **Writes are held to a stricter symlink rule than reads.** `openRead` follows a link that resolves
  inside the jail; `openWrite` refuses any path containing a symlink at all, even one pointing back
  inside. Not because following it would escape — it would not — but because the human approved a
  prompt that said "write `alias.txt`", and writing to whatever it points at is a different action
  than the one they agreed to. `packages/daemon/test/jail.test.ts` pins both halves of this.
- **Approval nonces are minted, remembered and spent by the daemon.** The extension renders the
  prompt and relays a click; it cannot invent a nonce, reuse one, or answer a call it was not
  offered. Silence, a timeout, a `cancel`, or a dropped socket are all denials — nothing about an
  approval fails open.
- **Anything refusable without side effects is refused before the prompt.** A `Tool.validate` hook
  runs ahead of `Policy.decide`, so the user is never asked to approve an `exec_run` that the
  allowlist will reject anyway. Prompting and then refusing teaches the user that approving is
  harmless, which is the opposite of what the prompt is for.
- **The call id is claimed before the approval wait, not after.** Otherwise two calls sharing an id
  both slip past the duplicate check while the first sits in front of a human, and each raises its
  own prompt.
- **Exec gets a rebuilt environment, not `process.env`.** Inheriting it would hand a prompt-injected
  `git push` the user's credential helper and every API key in their shell profile.

## Component responsibilities

Keep these boundaries — collapsing them is how the security model quietly dies.

- **Content script** — DOM only: find the composer, inject the protocol preamble, observe streamed
  assistant output, paste results back. Holds no socket and no secrets.
- **Service worker** — the only holder of the WebSocket and the pairing token. Relays between content
  script and daemon. WebSocket traffic keeps an MV3 service worker alive, so the connection can be
  long-lived; still handle re-connect on wake.
- **Daemon** — tool registry, jail enforcement, MCP client, process supervision.

### Per-site adapters

Each supported host needs its own selectors for composer / submit / message stream, and each of those
sites ships DOM changes constantly. Keep every site-specific selector in one adapter module per host
so breakage is a one-file fix, and make the adapter interface the *only* site-aware surface.

Rules learned by getting this wrong against the real chatgpt.com DOM:

- **Never scope turn discovery to the conversation root.** `assistantTurns()` queries the document.
  When it took a root, one stale layout selector made it return nothing, which is indistinguishable
  from "the model has not replied yet" — a single wrong selector silently disabled the whole product.
  The root exists only to give the MutationObserver something to watch.
- **The assistant-turn selector is a correctness boundary, not a convenience — and it must fail
  closed.** User turns carry perfect tool calls the model never made: the injected preamble's *worked
  example*, and every tool result pasted back as a user message. Scanning one therefore executes a
  call nobody requested, and once is enough to be wrong — de-duplication does not help. Both
  rendering styles occur, and Gemini's is the worse one:
    - claude.ai renders user turns as real `<pre><code>` blocks, so the DOM path finds the call;
    - Gemini renders them as plain-text `<p class="query-text-line">` paragraphs with the literal
      ``` fences **left intact**, so the *text* path finds a complete, closed, valid call — no code
      block required.

  So: `touchesUserTurn` filters turns in both the adapter wrapper and `scan()`; it rejects anything
  that merely *contains* a user turn (Gemini's `.conversation-container` wraps `<user-query>` and
  `<model-response>` together and is therefore unusable as a turn selector); and the fallback returns
  **nothing** rather than widening to `document.body`. Returning nothing is visible in the
  diagnostics; guessing wide is a silent wrong action. The preamble's example also points at
  `path/to/file.txt` rather than a real file, so if the boundary ever slips the result is a loud
  `jail_violation` instead of a quiet successful read.
- **A code block can be two nested `<pre>`s.** ChatGPT wraps the block in an outer `<pre>` holding
  the header and Copy button, with the real content in a nested CodeMirror `<pre><code>`. Take the
  innermost, or you get the chrome text as the tool call and run every call twice.
- **The info string does not survive rendering.** ChatGPT shows the language as header *text*, not as
  a `language-*` class, so the tag is genuinely `null`. Never let a missing or wrong label veto a
  block — `collectFromBlocks({ acceptMislabelled: true })` lets the parser decide, at the same bar as
  `parseToolCall`.
- **Closedness inferred from the DOM is a guess, not an observation.** Treat inferred-unclosed as
  "needs a longer settling window", never as a refusal, or a host that looks permanently mid-stream
  deadlocks every call. Only the literal-text path may refuse outright.
- **An unterminated block is unfinished, not malformed.** `includeUnclosed` hands half-written blocks
  to the *call* path so the caller's settling window can decide — and it used to hand them to the
  error path too. Half a JSON object never parses, so every intermediate state of a long `fs_write`
  read as a broken tool call and drew its own "your tool call could not be read" reply, interrupting
  the model repeatedly while it wrote a big file. `collectFromBlocks` now requires `block.closed`
  before reporting an error, and the extension settles errors through the same gate as calls.
- **Everything already on screen when the scanner attaches is history, not work.** De-duplication
  lives in memory, so a page reload, an extension reload or a crashed content script empties it — and
  the next scan finds a transcript full of perfectly valid tool calls and starts working through
  them. A user reported exactly that: a call aborted, and reopening the tab later ran the command
  again. `CallGate.beginScan` writes off everything visible in the first `SEED_WINDOW_MS` (5s) after
  attach without running it. The window is not a single first scan because these are SPAs and the
  first scan can land before the turns hydrate; it disarms once there has been something to seed *or*
  once the window closes, so a brand-new chat does not stay armed and swallow the model's first real
  call.
- **Freshness is measured from the block's last edit, and never from the page.** `MAX_CALL_AGE_MS`
  (30s) drops a call that settled long ago and was never dispatched — a backgrounded tab, a blocked
  scan. Measured from the last time the text *changed*, so a call that streamed for a minute is not
  stale. Page timestamps are not used, and checking Perplexity settled it: an assistant turn carries
  **no time signal at all** — no `<time>`, no `datetime`, no `data-time*`, nothing in its attribute
  set (`aria-label, class, data-renderer, data-workflow-final-text, data-workflow-text-footer, dir,
  lang, style, type`). The only timestamp it renders anywhere is a hover-revealed span on the *user*
  bubble reading `23 Aug, 01:17` — the wrong element (`touchesUserTurn` exists to refuse reading
  those), no year, no timezone, and page-controlled text a prompt-injected page could write anything
  into. Observation time in the content script cannot be lied about.
- **The page cannot date a call, but we can date our own action.** There is no way to tell from the
  DOM whether a call was written 30 seconds or two days ago — see the Perplexity finding above. So
  `content/history.ts` records every dispatch in `chrome.storage.local`, keyed by thread path
  (`chatgpt.com/c/<id>`), and the scanner loads it *before* the first scan. A call this extension
  already ran is refused however fresh the page makes it look, and the popup can say "already ran 2d
  ago" rather than shrugging. Recorded at dispatch, not at completion: a call that was sent and then
  abandoned is exactly the one that must not be retried on the next load.
- **A call is recognised by the text of its block, so the `id` is what tells a repeat from a
  re-read.** The scanner sees a conversation, not a stream of events: a call it ran stays on screen
  forever, so "the same call again" and "the same call still there" are identical bytes unless the id
  differs. The preamble now says so — *give every call a new id; reusing one means "this is that
  call" and the repeat is ignored* — because the rule was being relied on without ever being stated.
  The id itself is a free-form string, never a UUID and never validated: `parseToolCall` takes any
  non-empty string and, when there is none, synthesises `h<hash(body)>` from the block. That fallback
  is deliberate — refusing a whole call over a missing id would be worse — but it has a consequence
  worth knowing: an id-less call is *content-addressed*, so two identical id-less calls are one call
  by definition. The id is echoed back in the result block, which is what gives the model something
  to count from.
- **The stored record only has a say for `REPLAY_WINDOW_MS` (60s) after attach.** A transcript
  replays immediately; past that window a matching call is the model asking again, not the page
  showing the same message, and the record forgets it rather than refusing. Unbounded it would be
  worse than the bug it fixes — a model that reuses call ids would have real repeats silently dropped
  for a week.
- **Seeding is the heuristic; the record is the fact.** Seeding has a tail — a page slow enough to
  hydrate after the 5s window defeats it — and the stored record is what closes it. Neither replaces
  the other: the record cannot know about calls made in a tab that never wrote to storage, and it is
  keyed by a URL that a brand-new chat does not have yet.
- **A skipped call is announced.** Silently not running looks exactly like a daemon that is not
  connected. `stale` reports to the popup; the diagnostics report carries a `skipped` count so
  "nothing happened when I reopened this tab" has an answer.
- **Don't trust the MutationObserver alone.** These are SPAs; the node you attached to can be
  swapped out and then fires nothing forever. A slow poll alongside it removes that failure class.
- **A selector the engine rejects must not throw.** `firstMatch`/`allMatches` swallow it — otherwise
  one bad selector in one fallback list takes down the entire content script.
- **Not one of the four hosts has a plainly-present send button when the composer is empty.** Gemini
  renders none at all; Perplexity renders none in the zero state (with "Use voice mode" in that slot)
  and a `disabled` one mid-thread; claude.ai renders one `disabled` inside an `inert` wrapper. This is
  the root of the worst bug so far. With no send button present, a fallback
  reaching for "the last visible button near the composer" lands on `aria-label="Use voice mode"` on
  Perplexity and `aria-label="Dictate"` on Gemini. `guessSubmitButton` therefore requires a positively
  send-ish label and returns `null` otherwise; Enter is the safe universal fallback, and both hosts
  accept it.
- **Check the button at the *click*, not at the lookup.** `isPlausibleSubmit` runs in `compose.ts`
  immediately before clicking, so it covers every route a button can arrive by. The guard originally
  lived only in the heuristic, which missed the case that actually bit a user: a hand-written adapter
  selector (`button[aria-label*="Submit" i]`) matching the mic. A guard covering only the guessing
  path does not cover the path where someone guessed in advance and wrote it down. Order adapter
  submit selectors specific-first for the same reason.
- **Veto on structure before wording, and check the wrapper too.** A send button is never a toggle and
  never opens a menu, so `aria-pressed`, `aria-haspopup` and `aria-expanded` are disqualifying on
  their own — that is what catches Perplexity's Search/Computer mode toggles, which carry no
  `aria-label` at all (no word list would have rejected "Computer"). Checked on the element *and up to
  two ancestors*, because Gemini wraps buttons in custom elements
  (`<gem-icon-button aria-haspopup="true"><button>`) and puts the ARIA on the wrapper. Bounded to two
  levels: a distant expanded ancestor says nothing about the button inside it.
- **Read every label source an icon-only button offers.** `aria-label`, `data-testid`, `title`, icon
  glyph attributes (`data-mat-icon-name`, `fonticon`), the SVG sprite reference
  (`#pplx-icon-microphone` is Perplexity's only clue), and the button's own short visible text. An
  *unlabelled* button is still allowed — plenty of real send buttons have no accessible name.
- **Scope by widening, not by a fixed parent walk.** Gemini's send button is a cousin several levels
  above the composer; a host using a `<form>` has it right alongside. Grow the search scope one
  ancestor at a time and take the nearest hit.
- **Prefer attributes over computed properties for focusability.** The `tabIndex` *property* default
  for a `contenteditable` div is not consistently specified across engines, so the composer heuristic
  tests `getAttribute("tabindex") !== "-1"`. Reading the property rejected real composers.
- **Editability needs both signals.** `isContentEditable` (computed, inherited) and the
  `contenteditable` attribute disagree in both directions — a child of an editable region has no
  attribute of its own, and some engines report nothing for the property. Requiring only the property
  meant refusing to type into composers that plainly were editable.
- **Every insertion path is guarded.** `execCommand` is deprecated and `DataTransfer` /
  `ClipboardEvent` are not universal, so each is wrapped: a missing API degrades to the next path and
  finally to a reported `insert_failed`, never an exception that surfaces as nothing happening.
- **User-turn markers differ wildly and none is guessable.** claude.ai `[data-perf-row="human"]`,
  chatgpt.com `[data-message-author-role="user"]`, Gemini `<user-query>`, Perplexity **nothing at
  all** — its bubble carries no data attribute, so the marker list keys on the Tailwind group name
  `[class*="user-bubble"]` and on `[data-testid="toggle-query-expand-button"]`. When adding a host,
  find its user marker *before* trusting its assistant selector.
- **An orphaned content script must not narrate Chrome at the user.** Reloading the extension while a
  chat page is open leaves the old content script running with a dead `chrome.runtime`, and every call
  throws `Extension context invalidated`. That was being pasted into the conversation verbatim as a
  tool error — observed live on perplexity.ai. It is now recognised, replaced with the one thing that
  fixes it ("reload this page"), and the scanner detaches: nothing it does afterwards can succeed.
- **Quill hosts have two contenteditables.** Gemini's composer is `div.ql-editor`, with a hidden
  `div.ql-clipboard` beside it. Typing into the clipboard one goes nowhere.
- **Every composer here is a rich-text editor whose empty state is not empty markup.** Quill (Gemini,
  `div.ql-editor`) idles at `<p><br></p>`; Lexical (Perplexity, `#ask-input`) at
  `<p dir="auto"><br></p>`; TipTap/ProseMirror (claude.ai, `[data-testid="chat-input"]`) at
  `<p data-placeholder="Write a message…" class="is-empty">` plus a trailing `<br>`. All three have
  `textContent === ""`, which is what the "is the user mid-sentence?" check relies on. Placeholders
  live in attributes or sibling `aria-hidden` nodes, never as text inside the editor.
- **A disabled send button is normal, not absent.** claude.ai renders `chat-input-send` at all times
  but leaves it `disabled` inside an `inert`, invisible wrapper while the composer is empty, showing
  "Use voice mode" in its place. Find it anyway and let the disabled check skip it — by the time the
  click happens, text has been inserted and it is live.
- Fixture-driven tests live in `packages/extension/test/` (vitest + jsdom) with real captured DOM in
  `test/fixtures/`. When a host breaks, capture the new DOM into a fixture *first*.

## The tool-call protocol

Web chat UIs expose no native function-calling to an extension, so the protocol is text:

1. Inject a preamble describing the available tools and a strict fenced-JSON call format.
2. Watch the streaming assistant message for a complete fence. **Do not fire on a partial fence** —
   streamed output will pass through syntactically incomplete states.
2a. By the time markdown has rendered, the backticks are gone — the block is a `<pre><code>` — so
   closedness cannot be read off the text any more. `content/serialize.ts` infers it instead, and
   pessimistically: while a turn is streaming, its *last* code block is assumed to still be growing.
2b. A closed fence is still not sufficient on its own, because a JSON object can be valid while
   incomplete (`{"tool":"fs_write"}` parses fine before `args` arrives). So a block must also stop
   changing for `STABLE_MS` before it runs. Both guards are load-bearing; keep both.
3. Dispatch to the daemon, then paste the result back as a new turn, clearly marked as tool output so
   the model doesn't mistake it for user intent.

Round-tripping through the visible conversation means every result is also context the model sees —
truncate large file reads rather than pasting a megabyte into the chat.

### Results too large to paste

Pasting is the bottleneck, not the bytes. Every composer here is a rich-text editor that reconciles a
node per line, so tens of thousands of characters through `execCommand("insertText")` is one
enormous synchronous task and the tab stops responding. Past the paste budget the same bytes go up
the host's own file-upload control instead, which is what `limits.maxAttachBytes` (1 MiB) bounds.

Rules the implementation settled, none of them optional:

- **The threshold lives in the daemon, and nowhere else.** `canAttach` on `call_tool` is the page
  saying it *has* an uploader; `maxReadBytes` is still what decides whether a result is oversized,
  and `attach` on the result is the daemon's instruction to upload it. The extension carries no
  policy — it may decline, never widen. `canAttach` is also the one field on that message a hostile
  page influences, so it must be harmless if it lies: it changes how many bytes come back, not what
  may be read, and a page with `fs_read` could already page the same file with `offset`.
- **An unconfirmed upload is a failure.** `attachFile` waits for the host to show the file — matched
  on the filename *stem*, because these chips drop the extension — and clears the input if it never
  appears. Sending "the output is attached" with nothing attached is worse than truncating: the model
  answers from the covering note. Every failure falls back to a shortened paste.
- **Attach before typing.** A failed upload then leaves the composer untouched, so the fallback has
  somewhere to paste into.
- **A host may have no input until you ask for one, and asking means clicking.** Gemini creates its
  uploader in an overlay on demand, so `fileInput()` is null at rest. `uploadTrigger()` names the
  button that reveals it; `revealFileInput` clicks it, waits, and `dismissUploader` toggles it back
  when `aria-expanded` still says open. This is the second element the extension clicks unprompted,
  so it gets the `isPlausibleSubmit` treatment in advance: `isPlausibleUploadTrigger` demands a
  positively upload-ish label and — unlike the send check — refuses an *unlabelled* element too,
  because there is no Enter-key fallback to make a miss cheap. `uploadTrigger` is never guessed:
  finding an input is harmless, clicking something to produce one is not.
- **Uploaders come in two shapes, and only one of them needs a click.** Perplexity, claude.ai and
  chatgpt.com keep a real `input[type="file"]` in the composer at all times; Gemini alone builds one
  on demand. Check for the input first and click nothing when it is already there.
- **An attachment is the file, named as the file.** `fs_read` of `漢検漢字辞典漢字.csv` uploads
  `webmcp-c2-漢検漢字辞典漢字.csv`, `text/csv`, holding the file's bytes and nothing else. Three
  rules got it there, each of which was wrong in the first version:
    - **Name it after the source**, not `webmcp-<tool>-<id>.md`. The name is the only thing in the
      turn saying which file this is. It is sanitised as a *filename* — separators, control
      characters and the Windows-reserved set removed — never with `safeName`'s `[A-Za-z0-9_-]` rule,
      which turns a Japanese filename into a row of dashes and destroys the thing being added.
    - **Drop the daemon's framing from the body.** `fs_read` prefixes `path (N bytes)` for a result
      that will be *read in the chat*; inside an uploaded file that line is corruption — a CSV gains
      a bogus first row, a JSON file stops parsing — and it was the whole reason attachments had to
      be renamed `.md`. `ToolContext.canAttach` tells the tool which it is producing. Nothing is
      lost: the path and size are in the covering message and in the filename.
    - **`.md` is the fallback, not the default.** Both hosts with an `accept` list take `.csv`,
      `.json` and `.ts`; neither takes `.zig` or `.log`. So the extension checks `acceptsFile` and
      appends `.md` only when the real extension would be refused — then rewrites the covering
      message so it does not name a file that is not the one attached.
- **Confirm on the `marker`, never on the filename.** The conversation almost certainly contains the
  source filename already — the user just asked for that file by name — so matching it would confirm
  an upload that never happened. `marker` (`webmcp-c2`) cannot occur naturally and is short enough to
  survive a chip that truncates.
- **A host can have several file inputs, most of them wrong.** chatgpt.com has four at rest and three
  are image pickers. `acceptsFile` is what separates them, which is why it runs both where an input
  is chosen and again where the file is handed over.
- **A menu item that opens the OS file picker is not an upload trigger.** claude.ai's "+" menu has
  `data-testid="add-menu-upload-file"` ("Add files or photos", ⌘U) which looks exactly like Gemini's
  trigger and is the opposite of useful: there is nothing to reveal — the input is already at rest —
  and clicking it opens a *native* dialog that no page can drive and nothing here can dismiss,
  leaving it in front of the user while the upload fails anyway. A trigger is only worth naming when
  it materialises an `input` in the DOM. A regression test pins claude.ai as declaring no trigger.
- **Dismiss by toggling, not with Escape.** A stray Escape in a chat UI can clear a draft or close
  something else; and a menu that already closed itself would be *reopened* by a second click, which
  is why `aria-expanded` is checked first.
- **Confirm the upload against the composer, not the input.** A revealed input lives in an overlay
  that is torn down when the menu closes, so a scope walked up from it is an orphaned subtree no chip
  can ever appear in. `chipScope(composer)` is passed explicitly.
- **Re-check `accept` at the point of use, not only where the input was found.** The same lesson as
  `isPlausibleSubmit`: the adapter's selector list ends in a bare `input[type="file"]`, which on a
  host that moves its uploader can match an avatar picker whose `image/*` would silently swallow the
  file.
- **A result that is one enormous line was the case that escaped the budget entirely.** `readLineRange`
  emitted at least one line whatever its size, so a minified bundle or single-line JSON ignored
  `maxReadBytes` and went straight into the composer — the exact input the cap exists for. It is now
  cut to the budget, and says so with a different notice, because the usual "continue at
  `offset: n+1`" would silently skip the rest of that line.

## MCP aggregation

The daemon is an MCP **host**: it connects configured servers (stdio or HTTP) as a client, lists their
tools, and re-exports them alongside the built-in local tools in a single registry.

- Namespace downstream tools on ingest (`notion__search`) so two servers can't collide, and strip the
  namespace when routing the call onward.
- Server config belongs in a file the daemon reads at startup, in the shape of
  `claude_desktop_config.json` (command, args, env per server) — users will already have those blocks.
- A downstream server that is slow, crashed, or missing must degrade to "that tool is unavailable",
  never block the built-in local tools from being listed.

## Commands

```bash
npm install                    # once, at the repo root — it is a workspace

npm run build                  # protocol -> daemon -> extension, in that order
npm run typecheck              # every package
npm test                       # both suites: daemon, then extension
npm test -w @webmcp/daemon     # jail, protocol, tools, server
npm test -w @webmcp/extension  # adapters and DOM scraping, against captured fixtures (jsdom)
```

Running a single test file or a single case:

```bash
npx vitest run --root packages/daemon test/jail.test.ts
npx vitest run --root packages/daemon -t "classic escape"
npx vitest run --root packages/extension test/serialize.test.ts
npx vitest --root packages/daemon              # watch mode
```

Running the daemon:

```bash
npm run daemon -- --workspace ~/code/thing            # builds, then runs
npm run daemon -- --workspace ~/code/thing --verbose  # connection + MCP detail on stderr
node packages/daemon/dist/cli.js --print-token        # print the token and exit
node packages/daemon/dist/cli.js --help
```

Changing the workspace of a daemon that is already running — no restart, no re-pairing:

```bash
node packages/daemon/dist/cli.js --set-workspace ~/code/other   # grants it and switches
kill -HUP $(pgrep -f webmcp-daemon)                             # or just re-read the config
```

Once two roots are granted, the popup's picker moves between them. Either way the chat still holds a
preamble naming the old root, so re-inject the tool instructions after a switch — the popup says so.

The startup banner prints the pairing token every time, not only on first run —
needing a second command to go and fetch it was pure friction, and this terminal
is already where the audit log goes. `--hide-token` suppresses it for
screensharing. The token is also just a file: `cat .webmcp/token`.

Config lives at `.webmcp/config.json` in the **project root** — the npm workspace root, found by
walking up from the daemon module rather than from `cwd`, so where you were standing when you typed
the command cannot change which config is read. Override with `--config`. Deliberately not `$HOME`:
config, token and allowlist are one visible directory beside the code that the user can inspect and
delete, instead of state hiding elsewhere on the disk. `.gitignore` already covers `.webmcp/`, and
the directory is created `0700` with every file inside it `0600`. `mcpServers` takes
`claude_desktop_config.json` blocks verbatim; `workspace`, `workspaces`, `port`, `exec.allow` and
`limits` are WebMCP's own. `workspaces` is the set the root may be switched to at runtime and is the
consent decision behind the popup's picker — only the workspace fields are applied on reload, since
ports, exec allowlists and MCP blocks are wired into objects built at startup. Under `limits`,
`maxReadBytes` (64 KiB) is the *paste* budget and `maxAttachBytes` (1 MiB) the ceiling for a result
the page will upload instead; the two are resolved per call in `server.ts` from `canAttach` and
reach the tool as `ctx.maxResultBytes`. The pairing token and the standing-approval allowlist sit next to it as `token` and
`allowlist.json`, both `0600`.

Driving the daemon by hand, without a browser — the fastest way to tell "the daemon is broken" apart
from "the content script cannot find the DOM":

```bash
node scripts/probe.mjs tools
node scripts/probe.mjs roots
node scripts/probe.mjs workspace ~/code/other
node scripts/probe.mjs call fs_read '{"path":"README.md"}'
node scripts/probe.mjs --allow call exec_run '{"command":"git","args":["status"]}'
node scripts/probe.mjs --attach call fs_read '{"path":"big.json"}'   # claim a page with an uploader
node scripts/probe.mjs --port 8792 --deny call fs_write '{"path":"x","content":"y"}'
```

Loading the extension:

```bash
npm run build -w @webmcp/extension     # or: npm run watch -w @webmcp/extension
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/dist`. Open the
popup, paste the token and port, Pair. On a chat page, use **Inject tool instructions into this chat**
to put the preamble in the conversation — it is a button rather than something automatic because it
sends a message as the user.

Stdout is the audit log (`RUN` / `DENIED` / `REJECTED` / `FAILED` per call); stderr is diagnostics.

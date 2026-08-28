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
  streaming flags (`data-perf-row-streaming`, `data-is-streaming`) and assistant turns
  (`[data-perf-row="assistant"]`) all pinned. The richest fixture of the four — it is the one that
  revealed the user-turn hazard.
- **chatgpt.com** — working. Assistant turn and nested-`<pre>` code block confirmed and pinned.
- **perplexity.ai** — fully confirmed, both ends. Composer (`#ask-input`, Lexical), answers
  (`[data-workflow-final-text]`, with the Copy/Share/thumbs row a *sibling*
  `[data-workflow-text-footer]`), code blocks (`<pre><figure><figcaption>` — the language label lives
  in the figcaption *outside* the `<code>`) and `button[aria-label="Submit"]` all pinned. This is
  where the voice-mode click happened; a regression test asserts *no* button is clicked on the zero
  state. Only `isStreaming` is still a guess — the captured thread was idle.
- **gemini.google.com** — fully confirmed, both ends, and observed executing `fs_read` and `fs_write`
  end to end. Composer (`div.ql-editor`, Quill), conversation root, assistant turns
  (`<model-response>` → `<message-content>`), code blocks (`<code-block>` →
  `<pre><code data-test-id="code-content">`) and streaming (`aria-busy` on `.markdown-main-panel`) all
  pinned. Like Perplexity it renders **no send button** until the composer has text, and delivers via
  Enter.

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
ports, exec allowlists and MCP blocks are wired into objects built at startup. The pairing token and the standing-approval allowlist sit next to it as `token` and
`allowlist.json`, both `0600`.

Driving the daemon by hand, without a browser — the fastest way to tell "the daemon is broken" apart
from "the content script cannot find the DOM":

```bash
node scripts/probe.mjs tools
node scripts/probe.mjs roots
node scripts/probe.mjs workspace ~/code/other
node scripts/probe.mjs call fs_read '{"path":"README.md"}'
node scripts/probe.mjs --allow call exec_run '{"command":"git","args":["status"]}'
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

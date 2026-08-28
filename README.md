# WebMCP

Local MCP tool access for browser chat UIs — chatgpt.com, claude.ai, perplexity.ai and
gemini.google.com.

Two pieces that ship together:

- a **local daemon** that owns all execution: filesystem tools jailed to one directory, allowlisted
  shell commands, and any number of downstream MCP servers re-exported as one flat tool list;
- a **Chrome extension (MV3)** that injects a text tool-call protocol into the chat page, watches the
  assistant's output for calls, and pastes results back into the conversation.

The daemon is the only trust boundary. The page is hostile by assumption — a tool call is text the
model typed, and any page the model read could have told it to type that — so the extension is a
transport and never a gatekeeper.

## Quick start

```bash
npm install
npm run build
npm run daemon -- --workspace ~/code/some-project
```

The lone `--` is npm's "stop reading flags, hand the rest to the script", and it is not optional here:
`--workspace` is npm's own flag for selecting a package in a monorepo as well as WebMCP's flag for
naming the jailed directory. Without the separator npm claims it first and fails with
`No workspaces found`. Once a config exists, `npm run daemon` on its own reads the directory from it
and the question goes away.

The daemon prints its pairing token on every start, so you never need a second command to go and
find it (`--hide-token` suppresses it for screensharing). Load `packages/extension/dist` as an
unpacked extension at `chrome://extensions`, open the popup, paste the token and port, and click
**Pair**.

On a chat page, click **Inject tool instructions into this chat** to put the tool preamble into the
conversation, then ask for something.

To point it at a different project later, without restarting the daemon or pairing again:

```bash
node packages/daemon/dist/cli.js --set-workspace ~/code/other-project
```

That grants the directory as well as switching to it, so the popup's picker can move between the two
from then on. Re-inject the tool instructions afterwards — the chat still holds a preamble naming the
old directory.

## Configuration

Everything lives in `.webmcp/` in the project root — `config.json`, the pairing `token`, and
`allowlist.json` for standing approvals, in one directory beside the code rather than scattered under
your home directory. It is git-ignored, created `0700`, and every file in it is `0600`. Override the
location with `--config <file>`.

The config is the daemon's authority: the browser half can never write to it, which is what makes the
settings below grants rather than suggestions.

```json
{
  "workspace": "/Users/you/code/project-a",
  "workspaces": ["/Users/you/code/project-a", "/Users/you/code/project-b"],
  "port": 8767,
  "exec": { "allow": ["git", "npm", "rg"] },
  "mcpServers": {
    "notion": { "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"] }
  }
}
```

- `workspace` — the directory the tools may touch right now.
- `workspaces` — every directory the root is allowed to *become*. This is the list the popup's picker
  offers, and the daemon refuses any switch to a directory that is not on it (or inside one of them).
- `port` — the loopback port the daemon listens on. Defaults to 8767; it is also what you type into
  the popup when pairing.
- `exec.allow` — the binaries `exec_run` will run, by basename. An empty list removes the shell tool
  from the daemon's advertised tools entirely rather than offering it and always refusing.
- `mcpServers` — `claude_desktop_config.json` blocks verbatim, so you can paste ones you already have.

A `limits` block tunes read/write ceilings and the approval timeout; see `CLAUDE.md` for those.

**The daemon watches this file.** Change `workspace`, save, and a running daemon moves within about a
second — no restart, no re-pairing. `--set-workspace` is just a wrapper that makes that edit for you:
it resolves the path, checks it is a real directory, and adds it to `workspaces` so the picker offers
it later. Editing by hand is equally supported; a half-saved file is ignored until the save finishes.

Only the two workspace fields are applied on a reload. `port`, `exec.allow` and `mcpServers` are wired
into objects built at startup, so changing those still needs a restart.

## What it will and will not do

- Filesystem reads run automatically inside the workspace you named. Nothing outside it is reachable:
  every path is symlink-resolved before it is checked, and re-checked at the moment it is opened.
- Writes and shell commands stop and ask you, every time, until you choose "always allow" for that
  specific shape (per binary, for exec). The daemon decides — the extension only shows the prompt.
  A standing "always allow" belongs to the workspace it was granted in and does not follow you into
  another one.
- The workspace can move while the daemon runs, but only between directories listed in the config
  file — the one channel the browser half cannot reach. The popup's picker moves between them;
  nothing arriving from a page can name a directory that is not already on that list.
- Shell commands run with no shell: a real `argv`, an allowlisted binary, the workspace as `cwd`, and
  a rebuilt environment that does not include your shell's secrets.
- Downstream MCP servers reach the network by nature. Enabling one is its own consent decision,
  separate from the filesystem grant.
- Tool output is pasted into the visible conversation, so it is context the model pays for. Large
  reads are truncated rather than dumped.

See `CLAUDE.md` for the architecture, the security invariants, and the full command reference.

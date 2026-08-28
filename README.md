# WebMCP

Local MCP tool access for browser chat UIs — chatgpt.com, claude.ai, perplexity.ai.

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

The daemon prints a pairing token on first run. Load `packages/extension/dist` as an unpacked
extension at `chrome://extensions`, open the popup, paste the token and port, and click **Pair**.

On a chat page, click **Inject tool instructions into this chat** to put the tool preamble into the
conversation, then ask for something.

## What it will and will not do

- Filesystem reads run automatically inside the workspace you named. Nothing outside it is reachable:
  every path is symlink-resolved before it is checked, and re-checked at the moment it is opened.
- Writes and shell commands stop and ask you, every time, until you choose "always allow" for that
  specific shape (per binary, for exec). The daemon decides — the extension only shows the prompt.
- Shell commands run with no shell: a real `argv`, an allowlisted binary, the workspace as `cwd`, and
  a rebuilt environment that does not include your shell's secrets.
- Downstream MCP servers reach the network by nature. Enabling one in `~/.webmcp/config.json` is its
  own consent decision, separate from the filesystem grant.
- Tool output is pasted into the visible conversation, so it is context the model pays for. Large
  reads are truncated rather than dumped.

See `CLAUDE.md` for the architecture, the security invariants, and the full command reference.

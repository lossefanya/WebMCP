#!/usr/bin/env node
/**
 * A hand-driven wire client for the daemon — the extension's job, done by you.
 *
 * It exists because the browser half is the awkward half to test: this lets you
 * exercise the jail, the allowlist and the approval flow without Chrome in the
 * loop, and it is also the fastest way to tell "the daemon is broken" apart
 * from "the content script is not finding the DOM".
 *
 *   node scripts/probe.mjs tools
 *   node scripts/probe.mjs roots
 *   node scripts/probe.mjs workspace /path/to/other-project
 *   node scripts/probe.mjs call fs_read '{"path":"README.md"}'
 *   node scripts/probe.mjs call exec_run '{"command":"git","args":["status"]}'
 *   node scripts/probe.mjs --port 8792 --deny call fs_write '{"path":"x","content":"y"}'
 *   node scripts/probe.mjs --attach call fs_read '{"path":"big.txt"}'   # oversized -> marked for upload
 *
 * Approval prompts are answered on stdin unless --allow/--deny is passed.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";

// The daemon keeps its state beside the project, so this script looks in the
// same place rather than in $HOME. `scripts/` sits directly under the root.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const bool = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
};

const auto = bool("--allow") ? "allow_once" : bool("--deny") ? "deny" : null;
// Claim what a chat page with a file input claims, so an oversized result comes
// back whole and marked for upload instead of truncated to the paste budget.
const canAttach = bool("--attach");
const port = Number(flag("--port", process.env.WEBMCP_PORT ?? 8767));
const tokenFile = flag("--token-file", path.join(projectRoot, ".webmcp", "token"));
const origin = flag("--origin", "https://chatgpt.com");
const [command, toolName, argsJson] = args;

// `workspace` takes a directory where `call` takes a tool name — same slot.
if (!command || ((command === "call" || command === "workspace") && !toolName)) {
  process.stderr.write(
    "usage: probe.mjs [--port N] [--allow|--deny] [--attach] tools | roots | workspace <dir> | call <tool> [json]\n",
  );
  process.exit(2);
}

let token;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch {
  process.stderr.write(`cannot read token at ${tokenFile} — is the daemon running?\n`);
  process.exit(1);
}

let toolArgs = {};
if (argsJson) {
  try {
    toolArgs = JSON.parse(argsJson);
  } catch (err) {
    process.stderr.write(`arguments are not valid JSON: ${err.message}\n`);
    process.exit(2);
  }
}

const socket = new WebSocket(`ws://127.0.0.1:${port}`);
const send = (message) => socket.send(JSON.stringify(message));
const done = (code) => {
  socket.close();
  // Not `process.exit`. Writing a large result and exiting immediately truncates
  // stdout when it is a pipe, which quietly turned a 200KB read into whatever
  // fitted in the buffer — exactly the measurement this script exists to make.
  // Setting the code and letting the socket close drains the write first.
  process.exitCode = code;
};

const timeout = setTimeout(() => {
  process.stderr.write("timed out\n");
  done(1);
}, 300_000);
timeout.unref();

socket.addEventListener("error", () => {
  process.stderr.write(`cannot reach the daemon on 127.0.0.1:${port}\n`);
  process.exit(1);
});

socket.addEventListener("open", () => {
  send({ kind: "hello", version: 1, token, client: "probe" });
});

socket.addEventListener("message", async (event) => {
  const message = JSON.parse(String(event.data));

  switch (message.kind) {
    case "ready":
      process.stderr.write(`workspace: ${message.workspace}\n`);
      for (const server of message.servers) {
        process.stderr.write(
          `mcp:${server.id} ${server.state}${server.error ? ` (${server.error})` : ""}\n`,
        );
      }
      process.stderr.write(`roots:     ${(message.roots ?? []).join(", ") || "none"}\n`);
      if (command === "roots") done(0);
      else if (command === "tools") send({ kind: "list_tools", id: "1" });
      // The popup's route, driven by hand. The daemon refuses anything that is
      // not a granted root, so this is also how you check that it does.
      else if (command === "workspace") send({ kind: "set_workspace", id: "1", root: toolName });
      else send({ kind: "call_tool", id: "1", name: toolName, args: toolArgs, origin, canAttach });
      return;

    case "workspace_changed":
      process.stdout.write(`workspace is now ${message.workspace}\n`);
      done(0);
      return;

    case "tools":
      for (const tool of message.tools) {
        const params = Object.keys(tool.inputSchema.properties ?? {}).join(", ");
        process.stdout.write(`${tool.name}(${params})  [${tool.risk}]\n`);
      }
      done(0);
      return;

    case "approval_request": {
      process.stderr.write(`\napproval needed: ${message.summary}\n${message.detail}\n`);
      const decision = auto ?? (await prompt(message.allowAlwaysLabel));
      process.stderr.write(`-> ${decision}\n\n`);
      send({ kind: "approval_response", nonce: message.nonce, decision });
      return;
    }

    case "result":
      for (const part of message.result.content) {
        // Printed rather than the body: with --attach an oversized result comes
        // back whole, and dumping a megabyte into the terminal is not the thing
        // being checked.
        if (part.attach) {
          process.stdout.write(
            `[webmcp: ${part.text.length} chars, marked for upload as ${part.attach.filename}` +
              ` (${part.attach.mediaType})]\n`,
          );
          continue;
        }
        process.stdout.write(`${part.text}\n`);
      }
      done(message.result.isError ? 1 : 0);
      return;

    case "error":
      process.stderr.write(`${message.code}: ${message.message}\n`);
      done(1);
      return;
  }
});

async function prompt(alwaysLabel) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const hint = alwaysLabel ? "y = once, a = always, n = deny" : "y = allow, n = deny";
    const answer = (await rl.question(`${hint} > `)).trim().toLowerCase();
    if (answer === "y") return "allow_once";
    if (answer === "a" && alwaysLabel) return "allow_always";
    return "deny";
  } finally {
    rl.close();
  }
}

#!/usr/bin/env node
import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  configPathFor,
  defaultConfigPath,
  grantWorkspace,
  loadConfig,
  stateDirFor,
  type ConfigOverrides,
} from "./config.js";
import { WorkspaceManager } from "./workspace.js";
import { createLogger, type Logger } from "./log.js";
import { McpManager } from "./mcp/manager.js";
import { Policy } from "./policy.js";
import { Registry } from "./registry.js";
import { DaemonServer } from "./server.js";
import { loadOrCreateToken } from "./token.js";

const USAGE = `webmcp-daemon — local execution half of WebMCP

  webmcp-daemon --workspace <dir> [options]

Options
  -w, --workspace <dir>   Directory the tools are allowed to touch. Required
                          unless "workspace" is set in the config file.
  -p, --port <n>          Loopback port to listen on.
  -c, --config <file>     Config file. Default ${defaultConfigPath()}
      --set-workspace <dir>
                          Point the config at <dir>, add it to the switchable
                          set, and exit. A daemon that is already running picks
                          the change up without a restart.
      --print-token       Print the pairing token and exit without starting.
      --hide-token        Do not print the token on startup (for screensharing).
      --verbose           Log connection and MCP detail to stderr.
  -h, --help              This text.

The daemon listens on 127.0.0.1 only, and every connection must present the
pairing token. Paste the token into the extension popup once to pair.

The workspace root can move while the daemon runs, two ways, and both of them
go through the config file — which is what keeps a runtime switch a choice
between directories a human wrote down rather than a way to widen the grant:

  --set-workspace <dir>   from a terminal; grants <dir> and switches to it
  the popup's picker      switches between roots already in "workspaces"
`;

interface Args extends ConfigOverrides {
  help: boolean;
  printToken: boolean;
  hideToken: boolean;
  verbose: boolean;
  setWorkspace?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { help: false, printToken: false, hideToken: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-w":
      case "--workspace":
        out.workspace = next();
        break;
      case "-p":
      case "--port": {
        const port = Number(next());
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port`);
        out.port = port;
        break;
      }
      case "-c":
      case "--config":
        out.configPath = next();
        break;
      case "--set-workspace":
        out.setWorkspace = next();
        break;
      case "--print-token":
        out.printToken = true;
        break;
      case "--hide-token":
        out.hideToken = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  // Before `loadConfig`, deliberately: this prints and exits, and it should work
  // even when no workspace is configured yet. Stdout stays bare so it can be
  // piped straight into something else.
  if (args.printToken) {
    const token = await loadOrCreateToken(stateDirFor(args));
    process.stdout.write(`${token.token}\n`);
    return;
  }

  // Also before `loadConfig`: this is how the *first* workspace gets configured,
  // so it cannot require one to already be there.
  if (args.setWorkspace !== undefined) {
    const granted = await grantWorkspace(args.setWorkspace, args);
    process.stdout.write(
      [
        `workspace:  ${granted.workspace}`,
        `granted:    ${granted.workspaces.join(", ")}`,
        `written to  ${granted.file}`,
        ``,
        `A running daemon picks this up within a second; there is no need to restart it.`,
        ``,
      ].join("\n"),
    );
    return;
  }

  const config = await loadConfig(args);
  const log = createLogger(args.verbose);
  const token = await loadOrCreateToken(config.stateDir);

  // Resolving the workspace before anything listens means a typo'd path fails
  // now, not on the first tool call.
  const workspaces = await WorkspaceManager.open(config.workspace, config.workspaces, log);

  const policy = new Policy(config, log, workspaces);
  await policy.load();

  const mcp = new McpManager(config, log);
  const registry = new Registry(config, mcp, log);

  const server = new DaemonServer({
    config,
    workspaces,
    registry,
    policy,
    mcp,
    token: token.token,
    log,
  });

  const port = await server.listen();
  mcp.start();

  const stopWatching = watchConfig(args, log, () => reloadNow(args, workspaces, log));

  const banner = [
    `webmcp daemon listening on ws://127.0.0.1:${port}`,
    `workspace: ${workspaces.root}`,
    workspaces.roots().length > 1
      ? `switchable: ${workspaces.roots().slice(1).join(", ")}`
      : `switchable: none — grant more with --set-workspace <dir>`,
    `tools:     ${registry.list().length} built-in`,
    Object.keys(config.mcpServers).length
      ? `mcp:       ${Object.keys(config.mcpServers).join(", ")} (connecting)`
      : `mcp:       none configured`,
    `allowlist: ${policy.list().length} standing rule(s)`,
  ];
  // Always shown, on every start. Hiding it after the first run only meant a
  // second command to go and fetch it, and the daemon's own terminal is already
  // where the audit log goes — it is not a place the token is newly exposed.
  // `--hide-token` exists for when that terminal is on a screen other people
  // can see.
  if (args.hideToken) {
    banner.push(`token:     hidden by --hide-token; it is in ${token.file}`);
  } else {
    banner.push(
      "",
      `Pair the extension with this token${token.fresh ? "" : " (unchanged since the last run)"}:`,
      "",
      `  ${token.token}`,
      "",
      `Stored in ${token.file} — pass --hide-token to keep it off screen.`,
    );
  }
  process.stdout.write(`${banner.join("\n")}\n`);

  process.on("SIGHUP", () => {
    log.info("SIGHUP — re-reading config");
    void reloadNow(args, workspaces, log);
  });


  const shutdown = async (signal: string) => {
    process.stdout.write(`\n${signal} — shutting down\n`);
    stopWatching();
    await server.close();
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Notice the config file changing, so `--set-workspace` in another terminal
 * reaches a daemon that is already running.
 *
 * Watches the *directory*, not the file: editors and `writeFile` alike replace
 * the file rather than truncating it, and a watch bound to the old inode then
 * goes silent forever. The debounce collapses the write/rename burst a single
 * save produces into one reload.
 */
function watchConfig(overrides: ConfigOverrides, log: Logger, apply: () => Promise<void>): () => void {
  const file = configPathFor(overrides);
  const dir = path.dirname(file);
  let timer: NodeJS.Timeout | undefined;
  let watcher: fsSync.FSWatcher;

  try {
    watcher = fsSync.watch(dir, { persistent: false }, (_event, name) => {
      if (name !== null && name !== path.basename(file)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // A half-saved file parses as garbage. `apply` keeps the current config
        // and waits for the next write: refusing to serve because someone is
        // mid-edit would be a worse failure than a stale root.
        void apply();
      }, 150);
      timer.unref?.();
    });
  } catch (err) {
    log.warn(`not watching ${file} for changes: ${(err as Error).message}`);
    return () => {};
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

/**
 * Re-read the config and apply the parts that can move.
 *
 * `--workspace` is deliberately dropped here. It says where to *start*, not
 * where to stay: leaving it in would mean a daemon launched the documented way
 * (`npm run daemon -- --workspace ~/code/thing`) could never be moved by
 * `--set-workspace`, which is most of the point. The flag still decides the
 * root at startup and still seeds the grantable set.
 *
 * Only the workspace is applied. Ports, exec allowlists and MCP server blocks
 * are wired into objects built at startup, and pretending to reload them would
 * be worse than saying plainly that they need a restart.
 */
async function reloadNow(
  overrides: ConfigOverrides,
  workspaces: WorkspaceManager,
  log: Logger,
): Promise<void> {
  try {
    const next = await loadConfig({ ...overrides, workspace: undefined });
    await workspaces.reload(next.workspace, next.workspaces);
  } catch (err) {
    // Reached when the config names no workspace at all, which is normal for a
    // daemon started purely from flags. Nothing to apply is not a failure.
    log.info(`config reload had nothing to apply: ${(err as Error).message}`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`webmcp: ${message}\n`);
  process.exit(1);
});

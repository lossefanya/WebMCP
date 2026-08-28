#!/usr/bin/env node
import { loadConfig, defaultConfigPath, stateDirFor, type ConfigOverrides } from "./config.js";
import { Workspace } from "./jail.js";
import { createLogger } from "./log.js";
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
      --print-token       Print the pairing token and exit without starting.
      --hide-token        Do not print the token on startup (for screensharing).
      --verbose           Log connection and MCP detail to stderr.
  -h, --help              This text.

The daemon listens on 127.0.0.1 only, and every connection must present the
pairing token. Paste the token into the extension popup once to pair.
`;

interface Args extends ConfigOverrides {
  help: boolean;
  printToken: boolean;
  hideToken: boolean;
  verbose: boolean;
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

  const config = await loadConfig(args);
  const log = createLogger(args.verbose);
  const token = await loadOrCreateToken(config.stateDir);

  // Resolving the workspace before anything listens means a typo'd path fails
  // now, not on the first tool call.
  const workspace = await Workspace.open(config.workspace);

  const policy = new Policy({ ...config, workspace: workspace.root }, log);
  await policy.load();

  const mcp = new McpManager(config, log);
  const registry = new Registry(workspace, { ...config, workspace: workspace.root }, mcp, log);

  const server = new DaemonServer({
    config: { ...config, workspace: workspace.root },
    registry,
    policy,
    mcp,
    token: token.token,
    log,
  });

  const port = await server.listen();
  mcp.start();

  const banner = [
    `webmcp daemon listening on ws://127.0.0.1:${port}`,
    `workspace: ${workspace.root}`,
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

  const shutdown = async (signal: string) => {
    process.stdout.write(`\n${signal} — shutting down\n`);
    await server.close();
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`webmcp: ${message}\n`);
  process.exit(1);
});

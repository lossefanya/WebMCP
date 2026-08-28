import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PORT } from "@webmcp/protocol";

/**
 * A downstream MCP server, in the shape of `claude_desktop_config.json` so a
 * user can paste blocks they already have.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transport alternative to `command`. */
  url?: string;
  disabled?: boolean;
}

export interface ExecConfig {
  /** Binary basenames the exec tool will run. Empty list disables exec entirely. */
  allow: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface Limits {
  /** Reads longer than this are truncated — the result is pasted into the chat. */
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
  /** How long a human has to answer an approval prompt before it auto-denies. */
  approvalTimeoutMs: number;
  /** Ceiling on a downstream MCP call, so a hung server can't wedge a tab. */
  downstreamTimeoutMs: number;
}

export interface Config {
  workspace: string;
  port: number;
  exec: ExecConfig;
  limits: Limits;
  mcpServers: Record<string, McpServerConfig>;
  /** Where the pairing token lives. */
  stateDir: string;
}

export const DEFAULT_EXEC_ALLOW = [
  "git",
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "node",
  "npm",
  "npx",
  "python3",
  "make",
  "sed",
  "awk",
  "wc",
  "head",
  "tail",
];

const DEFAULTS = {
  port: DEFAULT_PORT,
  exec: { allow: DEFAULT_EXEC_ALLOW, timeoutMs: 30_000, maxOutputBytes: 32_768 },
  limits: {
    maxReadBytes: 64 * 1024,
    maxWriteBytes: 1024 * 1024,
    maxListEntries: 500,
    approvalTimeoutMs: 120_000,
    downstreamTimeoutMs: 30_000,
  },
} as const;

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".webmcp", "config.json");
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface ConfigOverrides {
  workspace?: string;
  port?: number;
  configPath?: string;
}

/**
 * Where the token and allowlist live, resolved without reading or validating
 * the config. Printing the pairing token has nothing to do with the workspace
 * grant, so it must not be blocked by a missing one.
 */
export function stateDirFor(overrides: ConfigOverrides = {}): string {
  const configPath = overrides.configPath ? expandHome(overrides.configPath) : defaultConfigPath();
  return path.dirname(configPath);
}

/**
 * Read config from disk, then apply CLI overrides. A missing file is fine as
 * long as `--workspace` was given: the workspace grant is the one thing with
 * no safe default, so it is never inferred from `cwd`.
 */
export async function loadConfig(overrides: ConfigOverrides = {}): Promise<Config> {
  const configPath = overrides.configPath ? expandHome(overrides.configPath) : defaultConfigPath();
  const raw = await readJsonIfPresent(configPath);

  const workspaceRaw = overrides.workspace ?? asString(raw.workspace);
  if (!workspaceRaw) {
    throw new Error(
      `no workspace configured — pass --workspace <dir> or set "workspace" in ${configPath}`,
    );
  }

  const execRaw = asObject(raw.exec);
  const limitsRaw = asObject(raw.limits);

  return {
    workspace: expandHome(workspaceRaw),
    port: overrides.port ?? asNumber(raw.port) ?? DEFAULTS.port,
    exec: {
      allow: asStringArray(execRaw.allow) ?? [...DEFAULTS.exec.allow],
      timeoutMs: asNumber(execRaw.timeoutMs) ?? DEFAULTS.exec.timeoutMs,
      maxOutputBytes: asNumber(execRaw.maxOutputBytes) ?? DEFAULTS.exec.maxOutputBytes,
    },
    limits: {
      maxReadBytes: asNumber(limitsRaw.maxReadBytes) ?? DEFAULTS.limits.maxReadBytes,
      maxWriteBytes: asNumber(limitsRaw.maxWriteBytes) ?? DEFAULTS.limits.maxWriteBytes,
      maxListEntries: asNumber(limitsRaw.maxListEntries) ?? DEFAULTS.limits.maxListEntries,
      approvalTimeoutMs: asNumber(limitsRaw.approvalTimeoutMs) ?? DEFAULTS.limits.approvalTimeoutMs,
      downstreamTimeoutMs:
        asNumber(limitsRaw.downstreamTimeoutMs) ?? DEFAULTS.limits.downstreamTimeoutMs,
    },
    mcpServers: parseServers(raw.mcpServers),
    stateDir: path.dirname(configPath),
  };
}

function parseServers(value: unknown): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [id, entry] of Object.entries(asObject(value))) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      throw new Error(`invalid MCP server id ${JSON.stringify(id)}: use letters, digits, - and _`);
    }
    if (id.includes("__")) {
      throw new Error(`invalid MCP server id ${JSON.stringify(id)}: "__" is the namespace separator`);
    }
    const server = asObject(entry);
    const command = asString(server.command);
    const url = asString(server.url);
    if (!command && !url) {
      throw new Error(`MCP server ${id} needs either "command" or "url"`);
    }
    out[id] = {
      command,
      args: asStringArray(server.args) ?? [],
      env: asStringRecord(server.env) ?? {},
      url,
      disabled: server.disabled === true,
    };
  }
  return out;
}

async function readJsonIfPresent(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return {};
    throw new Error(`cannot read config ${file}: ${err.message}`, { cause });
  }
  try {
    return asObject(JSON.parse(text));
  } catch (cause) {
    throw new Error(`config ${file} is not valid JSON`, { cause });
  }
}

/* Small coercions — a hand-written config is user input, not a typed object. */

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}
function asStringRecord(v: unknown): Record<string, string> | undefined {
  const obj = asObject(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val !== "string") return undefined;
    out[k] = val;
  }
  return out;
}

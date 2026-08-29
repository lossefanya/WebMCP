import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Default kill time for a call that does not ask for one. */
  timeoutMs: number;
  /**
   * Ceiling on what a call may ask for. Separate from `timeoutMs` because the
   * default wants to be short — a wedged command should not hold a chat turn
   * for minutes — while `git clone` and `npm install` legitimately need longer
   * and can say so.
   */
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

export interface Limits {
  /** Reads longer than this are truncated — the result is pasted into the chat. */
  maxReadBytes: number;
  /**
   * Ceiling for a result the caller will *upload* instead of pasting.
   *
   * Applies only when the page said it can attach a file, and it replaces
   * `maxReadBytes` for that call rather than adding to it. Pasting is what the
   * small cap protects against — a rich-text composer given tens of thousands
   * of characters freezes the tab — and none of that applies to a file, so the
   * budget above it is about how much output is useful in a chat, not about
   * safety. Keep it finite anyway: the whole result crosses one WebSocket
   * frame and sits in memory at both ends.
   */
  maxAttachBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
  /** How long a human has to answer an approval prompt before it auto-denies. */
  approvalTimeoutMs: number;
  /** Ceiling on a downstream MCP call, so a hung server can't wedge a tab. */
  downstreamTimeoutMs: number;
}

export interface Config {
  workspace: string;
  /**
   * Roots the daemon may be switched to at runtime, beyond the active one.
   *
   * This list *is* the consent decision. It lives in a file only the user can
   * write, which is what makes a runtime switch a selection rather than a
   * widening — see `WorkspaceManager`. Adding a root is a terminal action
   * (`--set-workspace`, or an editor); it is deliberately not something the
   * browser half can do.
   */
  workspaces: string[];
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
  // `fs_write` with `create_dirs` already makes parents on the way to a file;
  // this is for the bare "make an empty directory" case, which had no route.
  "mkdir",
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
  exec: {
    allow: DEFAULT_EXEC_ALLOW,
    timeoutMs: 30_000,
    maxTimeoutMs: 300_000,
    maxOutputBytes: 32_768,
  },
  limits: {
    maxReadBytes: 64 * 1024,
    maxAttachBytes: 1024 * 1024,
    maxWriteBytes: 1024 * 1024,
    maxListEntries: 500,
    approvalTimeoutMs: 120_000,
    downstreamTimeoutMs: 30_000,
  },
} as const;

/**
 * The project directory the daemon was built in, found by walking up from this
 * module to the npm workspace root.
 *
 * Resolved from the module's own location rather than `process.cwd()`, because
 * where you happened to be standing when you typed the command should not
 * change which config the daemon reads. It works the same from `src/` under
 * vitest and from `dist/` in a real run, since both sit under the same root.
 *
 * The fallback, for a daemon installed outside a workspace, is the nearest
 * enclosing package — never the home directory, so state stays with the
 * install instead of appearing somewhere the user did not choose.
 */
let cachedRoot: string | undefined;

export function projectRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  let nearestPackage: string | undefined;

  for (let hops = 0; hops < 8; hops++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      nearestPackage ??= dir;
      // The workspace root is the repo root — the directory holding `packages/`.
      if (pkg.workspaces !== undefined) {
        cachedRoot = dir;
        return dir;
      }
    } catch {
      // No package.json here, or an unreadable one. Keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedRoot = nearestPackage ?? path.dirname(fileURLToPath(import.meta.url));
  return cachedRoot;
}

/**
 * Config, pairing token and standing allowlist all live in one directory, next
 * to the project rather than in `$HOME` — three files in one place the user can
 * see and delete, instead of state hiding somewhere else on the disk.
 */
export function defaultConfigPath(): string {
  return path.join(projectRoot(), ".webmcp", "config.json");
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

export function configPathFor(overrides: ConfigOverrides = {}): string {
  return overrides.configPath ? expandHome(overrides.configPath) : defaultConfigPath();
}

/**
 * Point the config file at a new root, and grant it.
 *
 * Both halves matter. `workspace` is where the daemon works; `workspaces` is
 * the set it may be switched back to from the popup later. Writing from the
 * terminal is what makes this a grant at all — it is the one channel the
 * browser cannot reach.
 *
 * The file is rewritten rather than patched in place, so a hand-written config
 * loses its comments. That is why it round-trips through `JSON.parse` of the
 * existing file: every key the user set is preserved, only these two change.
 */
export async function grantWorkspace(
  root: string,
  overrides: ConfigOverrides = {},
): Promise<{ file: string; workspace: string; workspaces: string[] }> {
  const file = configPathFor(overrides);
  const resolved = await fs.realpath(path.resolve(expandHome(root)));
  const st = await fs.stat(resolved);
  if (!st.isDirectory()) throw new Error(`not a directory: ${resolved}`);

  const raw = await readJsonIfPresent(file);
  const previous = (asStringArray(raw.workspaces) ?? []).map(expandHome);
  const previousActive = asString(raw.workspace);
  const workspaces = [...previous];
  for (const keep of [previousActive, resolved]) {
    if (keep && !workspaces.includes(keep)) workspaces.push(keep);
  }

  const next = { ...raw, workspace: resolved, workspaces };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { file, workspace: resolved, workspaces };
}

/**
 * Where the token and allowlist live, resolved without reading or validating
 * the config. Printing the pairing token has nothing to do with the workspace
 * grant, so it must not be blocked by a missing one.
 */
export function stateDirFor(overrides: ConfigOverrides = {}): string {
  return path.dirname(configPathFor(overrides));
}

/**
 * Read config from disk, then apply CLI overrides. A missing file is fine as
 * long as `--workspace` was given: the workspace grant is the one thing with
 * no safe default, so it is never inferred from `cwd`.
 */
export async function loadConfig(overrides: ConfigOverrides = {}): Promise<Config> {
  const configPath = configPathFor(overrides);
  const raw = await readJsonIfPresent(configPath);

  const declared = (asStringArray(raw.workspaces) ?? []).map(expandHome);
  const workspaceRaw = overrides.workspace ?? asString(raw.workspace) ?? declared[0];
  if (!workspaceRaw) {
    throw new Error(
      `no workspace configured — pass --workspace <dir> or set "workspace" in ${configPath}`,
    );
  }

  const execRaw = asObject(raw.exec);
  const limitsRaw = asObject(raw.limits);

  return {
    workspace: expandHome(workspaceRaw),
    workspaces: declared,
    port: overrides.port ?? asNumber(raw.port) ?? DEFAULTS.port,
    exec: {
      allow: asStringArray(execRaw.allow) ?? [...DEFAULTS.exec.allow],
      timeoutMs: asNumber(execRaw.timeoutMs) ?? DEFAULTS.exec.timeoutMs,
      maxTimeoutMs: Math.max(
        asNumber(execRaw.maxTimeoutMs) ?? DEFAULTS.exec.maxTimeoutMs,
        asNumber(execRaw.timeoutMs) ?? DEFAULTS.exec.timeoutMs,
      ),
      maxOutputBytes: asNumber(execRaw.maxOutputBytes) ?? DEFAULTS.exec.maxOutputBytes,
    },
    limits: {
      maxReadBytes: asNumber(limitsRaw.maxReadBytes) ?? DEFAULTS.limits.maxReadBytes,
      maxAttachBytes: asNumber(limitsRaw.maxAttachBytes) ?? DEFAULTS.limits.maxAttachBytes,
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

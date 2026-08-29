import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_EXEC_ALLOW, type Config } from "../src/config.js";
import { Workspace } from "../src/jail.js";
import type { Logger } from "../src/log.js";
import type { ToolContext } from "../src/tools/types.js";
import { WorkspaceManager } from "../src/workspace.js";

/**
 * A real temp directory, not a mock. The jail's whole job is to be right about
 * symlinks and races, and a fake fs would let it be wrong about both.
 */
export async function tempWorkspace(): Promise<{
  root: string;
  outside: string;
  /** A second real directory, granted alongside `root`, for switch tests. */
  other: string;
  workspace: Workspace;
  workspaces: WorkspaceManager;
  cleanup(): Promise<void>;
}> {
  const base = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "webmcp-test-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const other = path.join(base, "other");
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  await fsp.mkdir(other);
  const workspace = await Workspace.open(root);
  // `outside` is deliberately *not* granted — it is what a refused switch aims at.
  const workspaces = await WorkspaceManager.open(root, [other], silentLogger);
  return {
    root: workspace.root,
    outside,
    other: await fsp.realpath(other),
    workspace,
    workspaces,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    workspace: root,
    workspaces: [],
    port: 0,
    exec: {
      allow: [...DEFAULT_EXEC_ALLOW],
      timeoutMs: 5_000,
      maxTimeoutMs: 20_000,
      maxOutputBytes: 8_192,
    },
    limits: {
      maxReadBytes: 4_096,
      maxAttachBytes: 256 * 1_024,
      maxWriteBytes: 1_024 * 1_024,
      maxListEntries: 100,
      approvalTimeoutMs: 1_000,
      downstreamTimeoutMs: 1_000,
    },
    mcpServers: {},
    stateDir: root,
    ...overrides,
  };
}

export function testContext(workspace: Workspace, config: Config): ToolContext {
  return {
    workspace,
    config,
    origin: "https://example.test",
    signal: new AbortController().signal,
    maxResultBytes: config.limits.maxReadBytes,
    canAttach: false,
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  audit: () => {},
};

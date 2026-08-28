import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_EXEC_ALLOW, type Config } from "../src/config.js";
import { Workspace } from "../src/jail.js";
import type { Logger } from "../src/log.js";
import type { ToolContext } from "../src/tools/types.js";

/**
 * A real temp directory, not a mock. The jail's whole job is to be right about
 * symlinks and races, and a fake fs would let it be wrong about both.
 */
export async function tempWorkspace(): Promise<{
  root: string;
  outside: string;
  workspace: Workspace;
  cleanup(): Promise<void>;
}> {
  const base = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), "webmcp-test-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  const workspace = await Workspace.open(root);
  return {
    root: workspace.root,
    outside,
    workspace,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    workspace: root,
    port: 0,
    exec: { allow: [...DEFAULT_EXEC_ALLOW], timeoutMs: 5_000, maxOutputBytes: 8_192 },
    limits: {
      maxReadBytes: 4_096,
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
  return { workspace, config, origin: "https://example.test", signal: new AbortController().signal };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  audit: () => {},
};

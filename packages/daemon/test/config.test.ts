import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHome, loadConfig, stateDirFor } from "../src/config.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "webmcp-cfg-"));
  });
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

  const write = async (value: unknown) => {
    const file = path.join(dir, "config.json");
    await fsp.writeFile(file, JSON.stringify(value));
    return file;
  };

  it("insists on a workspace — there is no safe default", async () => {
    await expect(loadConfig({ configPath: path.join(dir, "missing.json") })).rejects.toThrow(
      /no workspace configured/,
    );
  });

  it("accepts a missing config file when the workspace comes from the CLI", async () => {
    const config = await loadConfig({
      workspace: dir,
      configPath: path.join(dir, "missing.json"),
    });
    expect(config.workspace).toBe(dir);
    expect(config.exec.allow).toContain("git");
  });

  it("lets the CLI override the file", async () => {
    const configPath = await write({ workspace: "/from/file", port: 1111 });
    const config = await loadConfig({ configPath, workspace: dir, port: 2222 });
    expect(config.workspace).toBe(dir);
    expect(config.port).toBe(2222);
  });

  it("reads claude_desktop_config.json-shaped server blocks", async () => {
    const configPath = await write({
      workspace: dir,
      mcpServers: {
        notion: { command: "npx", args: ["-y", "notion-mcp"], env: { TOKEN: "x" } },
        remote: { url: "https://example.test/mcp" },
        off: { command: "x", disabled: true },
      },
    });
    const config = await loadConfig({ configPath });
    expect(config.mcpServers.notion).toMatchObject({ command: "npx", args: ["-y", "notion-mcp"] });
    expect(config.mcpServers.remote?.url).toBe("https://example.test/mcp");
    expect(config.mcpServers.off?.disabled).toBe(true);
  });

  it("rejects a server whose id would break namespacing", async () => {
    const configPath = await write({ workspace: dir, mcpServers: { "no__good": { command: "x" } } });
    await expect(loadConfig({ configPath })).rejects.toThrow(/namespace separator/);
  });

  it("rejects a server id with characters that would confuse a tool name", async () => {
    const configPath = await write({ workspace: dir, mcpServers: { "bad id": { command: "x" } } });
    await expect(loadConfig({ configPath })).rejects.toThrow(/invalid MCP server id/);
  });

  it("rejects a server with neither command nor url", async () => {
    const configPath = await write({ workspace: dir, mcpServers: { half: { args: [] } } });
    await expect(loadConfig({ configPath })).rejects.toThrow(/needs either/);
  });

  it("ignores wrongly-typed values rather than trusting them", async () => {
    const configPath = await write({
      workspace: dir,
      port: "8080",
      exec: { allow: "git", timeoutMs: "soon" },
      limits: { maxReadBytes: null },
    });
    const config = await loadConfig({ configPath });
    expect(config.port).toBe(8767);
    expect(config.exec.allow).toContain("git");
    expect(config.exec.timeoutMs).toBe(30_000);
    expect(config.limits.maxReadBytes).toBe(64 * 1024);
  });

  it("allows an explicitly empty exec allowlist, which disables exec", async () => {
    const configPath = await write({ workspace: dir, exec: { allow: [] } });
    const config = await loadConfig({ configPath });
    expect(config.exec.allow).toEqual([]);
  });

  it("reports invalid JSON instead of silently starting with defaults", async () => {
    const file = path.join(dir, "config.json");
    await fsp.writeFile(file, "{oops");
    await expect(loadConfig({ configPath: file })).rejects.toThrow(/not valid JSON/);
  });

  it("resolves the state dir without needing a workspace", () => {
    // `--print-token` must work before anything is configured, so this path
    // cannot go through the workspace check.
    const configPath = path.join(dir, "config.json");
    expect(stateDirFor({ configPath })).toBe(dir);
    expect(stateDirFor()).toBe(path.join(os.homedir(), ".webmcp"));
  });

  it("expands a leading tilde", () => {
    expect(expandHome("~/code")).toBe(path.join(os.homedir(), "code"));
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("/absolute/~/x")).toBe("/absolute/~/x");
  });
});

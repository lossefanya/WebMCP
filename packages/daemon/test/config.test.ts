import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  expandHome,
  grantWorkspace,
  loadConfig,
  projectRoot,
  stateDirFor,
} from "../src/config.js";

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

  it("reads the switchable workspace set, expanding ~", async () => {
    const configPath = await write({ workspace: dir, workspaces: [dir, "~/elsewhere"] });
    const config = await loadConfig({ configPath });
    expect(config.workspaces).toEqual([dir, path.join(os.homedir(), "elsewhere")]);
  });

  it("falls back to the first granted root when no active one is named", async () => {
    const configPath = await write({ workspaces: [dir] });
    await expect(loadConfig({ configPath })).resolves.toMatchObject({ workspace: dir });
  });

  it("defaults the switchable set to empty", async () => {
    const configPath = await write({ workspace: dir });
    await expect(loadConfig({ configPath })).resolves.toMatchObject({ workspaces: [] });
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
    expect(stateDirFor()).toBe(path.join(projectRoot(), ".webmcp"));
  });

  it("keeps state with the project, not in the home directory", async () => {
    // The whole point of moving it: config, token and allowlist sit in one
    // visible directory next to the code, instead of appearing under $HOME.
    const root = projectRoot();
    expect(defaultConfigPath()).toBe(path.join(root, ".webmcp", "config.json"));
    expect(root.startsWith(os.homedir() + path.sep)).toBe(true);
    expect(path.dirname(defaultConfigPath())).not.toBe(path.join(os.homedir(), ".webmcp"));

    // It is the npm workspace root — the directory holding `packages/`.
    await expect(fsp.stat(path.join(root, "packages"))).resolves.toBeDefined();
    const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
    expect(pkg.workspaces).toBeDefined();
  });

  it("puts the token and the allowlist in the same directory as the config", () => {
    // One place the user can look at and delete, rather than three.
    const configPath = path.join(dir, "nested", "config.json");
    expect(stateDirFor({ configPath })).toBe(path.dirname(configPath));
  });

  it("expands a leading tilde", () => {
    expect(expandHome("~/code")).toBe(path.join(os.homedir(), "code"));
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("/absolute/~/x")).toBe("/absolute/~/x");
  });
});

describe("grantWorkspace", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "webmcp-grant-")));
    configPath = path.join(dir, "config.json");
  });
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

  it("writes the root and grants it, from nothing", async () => {
    const a = path.join(dir, "a");
    await fsp.mkdir(a);
    const result = await grantWorkspace(a, { configPath });

    expect(result.workspace).toBe(a);
    expect(result.workspaces).toEqual([a]);
    const config = await loadConfig({ configPath });
    expect(config.workspace).toBe(a);
    expect(config.workspaces).toEqual([a]);
  });

  it("keeps the root it replaces on the switchable list", async () => {
    // Otherwise `--set-workspace` is a one-way door: you would have to run it
    // again from a terminal to get back, which is the friction being removed.
    const [a, b] = [path.join(dir, "a"), path.join(dir, "b")];
    await fsp.mkdir(a);
    await fsp.mkdir(b);
    await grantWorkspace(a, { configPath });
    const result = await grantWorkspace(b, { configPath });

    expect(result.workspace).toBe(b);
    expect(result.workspaces).toEqual([a, b]);
  });

  it("preserves every other key in a hand-written config", async () => {
    const a = path.join(dir, "a");
    await fsp.mkdir(a);
    await fsp.writeFile(
      configPath,
      JSON.stringify({ port: 9999, mcpServers: { notion: { command: "npx" } } }),
    );
    await grantWorkspace(a, { configPath });

    const config = await loadConfig({ configPath });
    expect(config.port).toBe(9999);
    expect(Object.keys(config.mcpServers)).toEqual(["notion"]);
  });

  it("refuses a path that is not a directory", async () => {
    const file = path.join(dir, "a.txt");
    await fsp.writeFile(file, "x");
    await expect(grantWorkspace(file, { configPath })).rejects.toThrow(/not a directory/);
    await expect(grantWorkspace(path.join(dir, "nope"), { configPath })).rejects.toThrow();
  });

  it("stores a resolved path, so a symlinked root cannot be re-pointed later", async () => {
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    await fsp.mkdir(real);
    await fsp.symlink(real, link);
    const result = await grantWorkspace(link, { configPath });
    expect(result.workspace).toBe(real);
  });

  it("writes the config readable only by the user", async () => {
    const a = path.join(dir, "a");
    await fsp.mkdir(a);
    await grantWorkspace(a, { configPath });
    expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
  });
});

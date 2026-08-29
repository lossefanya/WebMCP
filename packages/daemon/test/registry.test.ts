import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager, ServerUnavailable } from "../src/mcp/manager.js";
import { Registry } from "../src/registry.js";
import { silentLogger, tempWorkspace, testConfig } from "./helpers.js";

describe("Registry", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;
  let mcp: McpManager | undefined;

  beforeEach(async () => {
    fixture = await tempWorkspace();
  });
  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
    await fixture.cleanup();
  });

  const build = (overrides = {}) => {
    const config = testConfig(fixture.root, overrides);
    mcp = new McpManager(config, silentLogger);
    return { config, registry: new Registry(config, mcp, silentLogger), mcp };
  };

  it("lists the built-in tools first", () => {
    const { registry } = build();
    expect(registry.list().map((t) => t.name)).toEqual([
      "fs_read",
      "fs_write",
      "fs_list",
      "fs_stat",
      "exec_run",
    ]);
  });

  it("withholds exec_run entirely when the allowlist is empty", () => {
    const { registry } = build({ exec: { allow: [], timeoutMs: 1_000, maxOutputBytes: 1_000 } });
    // Better to not advertise it than to advertise it and always refuse.
    expect(registry.list().map((t) => t.name)).not.toContain("exec_run");
    expect(registry.describe("exec_run")).toBeUndefined();
  });

  it("reports an unknown tool as unknown rather than throwing something opaque", async () => {
    const { registry } = build();
    await expect(
      registry.call("nope__missing", {}, "test", new AbortController().signal, fixture.workspace, 64 * 1024),
    ).rejects.toThrow(/unknown tool/);
  });

  it("marks every built-in read as auto-approvable and the rest as not", () => {
    const { registry } = build();
    const byName = new Map(registry.list().map((t) => [t.name, t.risk]));
    expect(byName.get("fs_read")).toBe("read");
    expect(byName.get("fs_list")).toBe("read");
    expect(byName.get("fs_stat")).toBe("read");
    expect(byName.get("fs_write")).toBe("write");
    expect(byName.get("exec_run")).toBe("exec");
  });

  it("summarizes a downstream call without needing the server to be up", () => {
    const { registry } = build();
    expect(registry.summarize("notion__search", { q: "x" })).toBe("Call search on notion");
  });
});

describe("MCP aggregation", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;
  let mcp: McpManager | undefined;

  beforeEach(async () => {
    fixture = await tempWorkspace();
  });
  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
    await fixture.cleanup();
  });

  it("does not let a broken downstream server block the local tools", async () => {
    const config = testConfig(fixture.root, {
      mcpServers: {
        broken: { command: "definitely-not-a-real-binary-xyz", args: [], env: {}, disabled: false },
      },
    });
    mcp = new McpManager(config, silentLogger);
    const registry = new Registry(config, mcp, silentLogger);

    mcp.start();
    // The local tools are listable straight away — no waiting on the server.
    expect(registry.list().map((t) => t.name)).toContain("fs_read");

    await waitFor(() => mcp!.statuses()[0]?.state === "failed");
    const status = mcp.statuses()[0]!;
    expect(status.id).toBe("broken");
    expect(status.toolCount).toBe(0);
    expect(status.error).toBeTruthy();

    // Still listable after the failure, and the failed server contributes nothing.
    expect(registry.list().map((t) => t.name)).toContain("exec_run");
    expect(registry.list().some((t) => t.server === "broken")).toBe(false);
  });

  it("calls into a server that is down as unavailable, not as a crash", async () => {
    const config = testConfig(fixture.root, {
      mcpServers: { broken: { command: "definitely-not-a-real-binary-xyz", args: [], env: {} } },
    });
    mcp = new McpManager(config, silentLogger);
    mcp.start();
    await waitFor(() => mcp!.statuses()[0]?.state === "failed");

    await expect(
      mcp.call("broken", "anything", {}, new AbortController().signal),
    ).rejects.toThrow(ServerUnavailable);
    await expect(
      mcp.call("never-configured", "anything", {}, new AbortController().signal),
    ).rejects.toThrow(/not configured/);
  });

  it("skips a server marked disabled in config", () => {
    const config = testConfig(fixture.root, {
      mcpServers: { off: { command: "x", args: [], env: {}, disabled: true } },
    });
    mcp = new McpManager(config, silentLogger);
    mcp.start();
    expect(mcp.statuses()).toEqual([]);
  });

  it("notifies listeners when a server's state changes", async () => {
    const config = testConfig(fixture.root, {
      mcpServers: { broken: { command: "definitely-not-a-real-binary-xyz", args: [], env: {} } },
    });
    mcp = new McpManager(config, silentLogger);
    let changes = 0;
    mcp.onChange(() => changes++);
    mcp.start();
    await waitFor(() => changes > 0);
    expect(changes).toBeGreaterThan(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition never became true");
}

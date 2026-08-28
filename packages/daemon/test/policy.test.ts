import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDescriptor } from "@webmcp/protocol";
import { Policy, allowKey } from "../src/policy.js";
import { silentLogger, tempWorkspace, testConfig } from "./helpers.js";

const descriptor = (over: Partial<ToolDescriptor>): ToolDescriptor => ({
  name: "fs_write",
  description: "",
  inputSchema: { type: "object" },
  risk: "write",
  server: null,
  ...over,
});

describe("Policy", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;
  let policy: Policy;

  beforeEach(async () => {
    fixture = await tempWorkspace();
    policy = new Policy(testConfig(fixture.root), silentLogger);
    await policy.load();
  });
  afterEach(() => fixture.cleanup());

  it("auto-approves reads — the jail is the grant", () => {
    expect(policy.decide(descriptor({ name: "fs_read", risk: "read" }), {})).toBe("auto");
  });

  it("requires approval for writes, exec and network", () => {
    expect(policy.decide(descriptor({ risk: "write" }), {})).toBe("needs_approval");
    expect(policy.decide(descriptor({ name: "exec_run", risk: "exec" }), { command: "git" })).toBe(
      "needs_approval",
    );
    expect(
      policy.decide(descriptor({ name: "notion__create", risk: "network", server: "notion" }), {}),
    ).toBe("needs_approval");
  });

  it("honours a standing allow, and only for the same shape", async () => {
    const exec = descriptor({ name: "exec_run", risk: "exec" });
    await policy.allowAlways(exec, { command: "git" });

    expect(policy.decide(exec, { command: "git", args: ["status"] })).toBe("auto");
    // A different binary is a different decision, even though the tool matches.
    expect(policy.decide(exec, { command: "npm" })).toBe("needs_approval");
  });

  it("scopes exec grants per binary and everything else per tool", () => {
    const exec = descriptor({ name: "exec_run", risk: "exec" });
    expect(allowKey(exec, { command: "git" })).toBe("exec_run:git");
    expect(allowKey(exec, { command: "npm" })).toBe("exec_run:npm");
    expect(allowKey(descriptor({}), { path: "a" })).toBe("fs_write");
    expect(allowKey(descriptor({}), { path: "b" })).toBe("fs_write");
  });

  it("persists standing allows across restarts, readable only by the user", async () => {
    await policy.allowAlways(descriptor({}), { path: "a.txt" });

    const file = path.join(fixture.root, "allowlist.json");
    const stat = await fsp.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);

    const reloaded = new Policy(testConfig(fixture.root), silentLogger);
    await reloaded.load();
    expect(reloaded.decide(descriptor({}), { path: "b.txt" })).toBe("auto");
  });

  it("revokes a standing allow", async () => {
    const exec = descriptor({ name: "exec_run", risk: "exec" });
    await policy.allowAlways(exec, { command: "git" });
    expect(await policy.revoke("exec_run:git")).toBe(true);
    expect(await policy.revoke("exec_run:git")).toBe(false);
    expect(policy.decide(exec, { command: "git" })).toBe("needs_approval");
  });

  it("survives a corrupt allowlist file rather than refusing to start", async () => {
    await fsp.writeFile(path.join(fixture.root, "allowlist.json"), "{not json");
    const fresh = new Policy(testConfig(fixture.root), silentLogger);
    await expect(fresh.load()).resolves.toBeUndefined();
    // Failing closed: nothing is allowed that was not read successfully.
    expect(fresh.decide(descriptor({}), {})).toBe("needs_approval");
  });

  it("offers no always-allow button for a read", () => {
    expect(policy.alwaysLabel(descriptor({ name: "fs_read", risk: "read" }), {})).toBeUndefined();
    expect(policy.alwaysLabel(descriptor({ name: "exec_run", risk: "exec" }), { command: "git" })).toContain(
      "git",
    );
  });
});

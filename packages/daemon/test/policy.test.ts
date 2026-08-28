import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDescriptor } from "@webmcp/protocol";
import { Policy, allowKey, canAllowAlways, scopedKey } from "../src/policy.js";
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
    await policy.allowAlways(exec, { command: "ls" });

    expect(policy.decide(exec, { command: "ls", args: ["-la"] })).toBe("auto");
    // A different binary is a different decision, even though the tool matches.
    expect(policy.decide(exec, { command: "cat" })).toBe("needs_approval");
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
    await policy.allowAlways(exec, { command: "ls" });
    expect(await policy.revoke("exec_run:ls")).toBe(true);
    expect(await policy.revoke("exec_run:ls")).toBe(false);
    expect(policy.decide(exec, { command: "ls" })).toBe("needs_approval");
  });

  it("keeps a standing allow inside the workspace it was granted in", async () => {
    // The button says "Always allow `git` in <project>". Carrying that into a
    // different root once the workspace can move would be the daemon doing
    // something other than what the human read and clicked.
    const scoped = new Policy(testConfig(fixture.root), silentLogger, fixture.workspaces);
    await scoped.load();
    const exec = descriptor({ name: "exec_run", risk: "exec" });
    await scoped.allowAlways(exec, { command: "ls" });
    expect(scoped.decide(exec, { command: "ls" })).toBe("auto");

    await fixture.workspaces.switchTo(fixture.other);
    expect(scoped.decide(exec, { command: "ls" })).toBe("needs_approval");

    // Not revoked, only out of scope — switching back restores it.
    await fixture.workspaces.switchTo(fixture.root);
    expect(scoped.decide(exec, { command: "ls" })).toBe("auto");
  });

  it("labels the always-allow button with the live root, not the startup one", async () => {
    const scoped = new Policy(testConfig(fixture.root), silentLogger, fixture.workspaces);
    await scoped.load();
    const exec = descriptor({ name: "exec_run", risk: "exec" });
    expect(scoped.alwaysLabel(exec, { command: "ls" })).toContain(path.basename(fixture.root));
    await fixture.workspaces.switchTo(fixture.other);
    expect(scoped.alwaysLabel(exec, { command: "ls" })).toContain(path.basename(fixture.other));
  });

  it("drops rules written before roots were recorded, rather than guessing one", async () => {
    // Failing closed: the worst case is one more approval prompt, where the
    // alternative is a standing grant applied to a directory nobody agreed to.
    await fsp.writeFile(
      path.join(fixture.root, "allowlist.json"),
      JSON.stringify({
        rules: [{ key: "exec_run:ls", label: "Always allow `ls`", addedAt: "2024-01-01" }],
      }),
    );
    const fresh = new Policy(testConfig(fixture.root), silentLogger);
    await fresh.load();
    expect(fresh.decide(descriptor({ name: "exec_run", risk: "exec" }), { command: "ls" })).toBe(
      "needs_approval",
    );
    expect(fresh.listAll()).toEqual([]);
  });

  it("separates the storage key from the tool key", () => {
    expect(scopedKey("/a", "fs_write")).not.toBe(scopedKey("/b", "fs_write"));
    // A NUL separator, so no root and tool name can be concatenated two ways.
    expect(scopedKey("/a", "fs_write")).toBe("/a\0fs_write");
  });

  describe("standing allows for exec", () => {
    const exec = descriptor({ name: "exec_run", risk: "exec" });

    // Each of these was verified escaping a live jail — arbitrary read, write,
    // or code execution outside the workspace — before being listed here.
    it.each(["node", "python3", "npm", "npx", "make", "awk", "find", "sed", "git", "sh", "bash"])(
      "never offers to remember %s",
      (command) => {
        expect(canAllowAlways(exec, { command })).toBe(false);
        expect(policy.alwaysLabel(exec, { command })).toBeUndefined();
      },
    );

    it("still offers to remember a binary that cannot run code of its own", () => {
      for (const command of ["ls", "cat", "mkdir", "wc", "head"]) {
        expect(canAllowAlways(exec, { command })).toBe(true);
        expect(policy.alwaysLabel(exec, { command })).toContain(command);
      }
      // Non-exec tools are unaffected.
      expect(policy.alwaysLabel(descriptor({}), { path: "a" })).toContain("fs_write");
    });

    it("refuses to record the rule even when told to, and keeps prompting", async () => {
      // The missing button is a UI hint. Authority is here: a decision claiming
      // "always" for `node` must not be remembered, however it arrived.
      await policy.allowAlways(exec, { command: "node" });
      expect(policy.decide(exec, { command: "node" })).toBe("needs_approval");
      expect(policy.listAll()).toEqual([]);

      // And the permitted case still works, so this is a restriction and not a
      // blanket disabling of standing allows.
      await policy.allowAlways(exec, { command: "ls" });
      expect(policy.decide(exec, { command: "ls" })).toBe("auto");
    });

    it("drops a rule saved before the binary was restricted", async () => {
      // Otherwise the fix protects only users who never clicked the button.
      await fsp.writeFile(
        path.join(fixture.root, "allowlist.json"),
        JSON.stringify({
          rules: [
            { key: "exec_run:node", root: fixture.root, label: "Always allow `node`", addedAt: "2024-01-01" },
            { key: "exec_run:ls", root: fixture.root, label: "Always allow `ls`", addedAt: "2024-01-01" },
          ],
        }),
      );
      const fresh = new Policy(testConfig(fixture.root), silentLogger);
      await fresh.load();

      expect(fresh.decide(exec, { command: "node" })).toBe("needs_approval");
      expect(fresh.decide(exec, { command: "ls" })).toBe("auto");
    });
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
    expect(policy.alwaysLabel(descriptor({ name: "exec_run", risk: "exec" }), { command: "ls" })).toContain(
      "ls",
    );
  });
});

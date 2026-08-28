import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execTools } from "../src/tools/exec.js";
import { ToolError } from "../src/tools/types.js";
import { tempWorkspace, testConfig, testContext } from "./helpers.js";

const exec = execTools[0]!;

describe("exec_run", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;

  beforeEach(async () => {
    fixture = await tempWorkspace();
  });
  afterEach(() => fixture.cleanup());

  const ctx = (overrides = {}) =>
    testContext(fixture.workspace, testConfig(fixture.root, overrides));

  const run = (args: Record<string, unknown>, overrides = {}) => exec.run(args, ctx(overrides));

  it("refuses a binary that is not on the allowlist", async () => {
    await expect(run({ command: "sh", args: ["-c", "echo pwned"] })).rejects.toThrow(
      /not on the exec allowlist/,
    );
  });

  it("refuses the same call at validate time, before any approval prompt", () => {
    // Prompting the user and *then* refusing teaches them that approving is
    // harmless, so the allowlist has to be checked before the prompt.
    const context = ctx();
    expect(() => exec.validate?.({ command: "sh", args: [] }, context)).toThrow(ToolError);
    expect(() => exec.validate?.({ command: "ls", args: [] }, context)).not.toThrow();
  });

  it.each(["/bin/ls", "./ls", "../ls", "sub/ls"])("refuses a path-shaped command %j", async (command) => {
    await expect(run({ command, args: [] })).rejects.toThrow(/bare binary name/);
  });

  it("refuses everything when the allowlist is empty", async () => {
    await expect(run({ command: "ls", args: [] }, { exec: { allow: [], timeoutMs: 1000, maxOutputBytes: 1000 } })).rejects.toThrow(
      /exec is disabled/,
    );
  });

  it("runs an allowlisted binary with the workspace as cwd", async () => {
    const result = await run({ command: "node", args: ["-e", "process.stdout.write(process.cwd())"] });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain(fixture.root);
  });

  it("does not interpret shell metacharacters", async () => {
    // With `shell: false` this argument reaches the program verbatim; a
    // string-interpolating implementation would have run `ls` here.
    const result = await run({
      command: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", "--", "$HOME; ls /"],
    });
    expect(result.content[0]?.text).toContain("$HOME; ls /");
  });

  it("does not hand the child the user's environment", async () => {
    process.env.WEBMCP_TEST_SECRET = "leaked";
    try {
      const result = await run({
        command: "node",
        args: ["-e", "process.stdout.write(String(process.env.WEBMCP_TEST_SECRET))"],
      });
      expect(result.content[0]?.text).toContain("undefined");
      expect(result.content[0]?.text).not.toContain("leaked");
    } finally {
      delete process.env.WEBMCP_TEST_SECRET;
    }
  });

  it("reports a non-zero exit as an error result", async () => {
    const result = await run({ command: "node", args: ["-e", "process.exit(3)"] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exit 3");
  });

  it("kills a process that outlives its timeout", async () => {
    const result = await run(
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 300 },
      { exec: { allow: ["node"], timeoutMs: 400, maxOutputBytes: 4096 } },
    );
    expect(result.content[0]?.text).toMatch(/timed out after/);
  });

  it("caps the timeout at the configured ceiling", async () => {
    const started = Date.now();
    await run(
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 9_000 },
      { exec: { allow: ["node"], timeoutMs: 300, maxOutputBytes: 4096 } },
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("truncates output rather than pasting it all into the chat", async () => {
    const result = await run(
      { command: "node", args: ["-e", "process.stdout.write('x'.repeat(50000))"] },
      { exec: { allow: ["node"], timeoutMs: 5_000, maxOutputBytes: 1_000 } },
    );
    expect(result.content[0]?.truncated).toBe(true);
    expect(result.content[0]?.text).toMatch(/truncated/);
    expect(result.content[0]?.text.length).toBeLessThan(2_000);
  });

  it("rejects a null byte in an argument", async () => {
    await expect(run({ command: "ls", args: ["a\0b"] })).rejects.toThrow(/null byte/);
  });

  it("rejects a non-array args", async () => {
    await expect(run({ command: "ls", args: "-a" })).rejects.toThrow(/array of strings/);
  });
});

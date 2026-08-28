import * as fsp from "node:fs/promises";
import * as path from "node:path";
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
    await expect(run({ command: "ls", args: [] }, { exec: { allow: [], timeoutMs: 1000, maxTimeoutMs: 20_000, maxOutputBytes: 1000 } })).rejects.toThrow(
      /exec is disabled/,
    );
  });

  it("runs an allowlisted binary with the workspace as cwd", async () => {
    const result = await run({ command: "node", args: ["-e", "process.stdout.write(process.cwd())"] });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain(fixture.root);
  });

  it("creates a directory with mkdir, which the default allowlist permits", async () => {
    // There was no route to a bare empty directory before this: `fs_write` makes
    // parents on the way to a file, and nothing made a directory on its own.
    const result = await run({ command: "mkdir", args: ["-p", "nested/deep"] });
    expect(result.isError).toBe(false);
    await expect(fsp.stat(path.join(fixture.root, "nested", "deep"))).resolves.toBeDefined();
  });

  it("lets a slow command ask for longer than the default", async () => {
    // `git clone` and `npm install` routinely outlive a default tuned so a
    // wedged command does not hold the conversation. Clamping to the default
    // meant they could never be given longer, whatever they asked for.
    const started = Date.now();
    const result = await run(
      { command: "node", args: ["-e", "setTimeout(()=>console.log('finished'),1200)"], timeout_ms: 15_000 },
      { exec: { allow: ["node"], timeoutMs: 400, maxTimeoutMs: 20_000, maxOutputBytes: 8_192 } },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("finished");
    expect(Date.now() - started).toBeGreaterThan(1_000);
  });

  it("still refuses to exceed the configured ceiling", async () => {
    const result = await run(
      { command: "node", args: ["-e", "setTimeout(()=>{},60000)"], timeout_ms: 999_999 },
      { exec: { allow: ["node"], timeoutMs: 200, maxTimeoutMs: 700, maxOutputBytes: 8_192 } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out after 700ms");
  });

  it("tells the model how to retry when it kills a slow command", async () => {
    // The status line is pasted into the conversation and is the only thing the
    // model gets to act on. "It timed out" alone leaves it with no next move.
    const result = await run(
      { command: "node", args: ["-e", "setTimeout(()=>{},60000)"] },
      { exec: { allow: ["node"], timeoutMs: 200, maxTimeoutMs: 90_000, maxOutputBytes: 8_192 } },
    );
    expect(result.content[0]?.text).toMatch(/retry with timeout_ms up to 90000/);
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
      { exec: { allow: ["node"], timeoutMs: 400, maxTimeoutMs: 20_000, maxOutputBytes: 4096 } },
    );
    expect(result.content[0]?.text).toMatch(/timed out after/);
  });

  it("applies the default timeout when a call does not ask for one", async () => {
    // The default stays short on purpose: an unattended wedged command must not
    // hold the conversation. Asking for longer is the opt-in, tested above.
    const started = Date.now();
    const result = await run(
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"] },
      { exec: { allow: ["node"], timeoutMs: 300, maxTimeoutMs: 20_000, maxOutputBytes: 4096 } },
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.content[0]?.text).toContain("timed out after 300ms");
  });

  it("truncates output rather than pasting it all into the chat", async () => {
    const result = await run(
      { command: "node", args: ["-e", "process.stdout.write('x'.repeat(50000))"] },
      { exec: { allow: ["node"], timeoutMs: 5_000, maxTimeoutMs: 20_000, maxOutputBytes: 1_000 } },
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

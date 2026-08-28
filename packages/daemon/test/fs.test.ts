import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsTools } from "../src/tools/fs.js";
import { tempWorkspace, testConfig, testContext } from "./helpers.js";

const byName = new Map(fsTools.map((t) => [t.descriptor.name, t]));
const fsRead = byName.get("fs_read")!;
const fsWrite = byName.get("fs_write")!;
const fsList = byName.get("fs_list")!;

describe("filesystem tools", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;

  beforeEach(async () => {
    fixture = await tempWorkspace();
    await fsp.writeFile(path.join(fixture.root, "a.txt"), "one\ntwo\nthree\n");
    await fsp.mkdir(path.join(fixture.root, "sub"));
    await fsp.writeFile(path.join(fixture.root, "sub", "b.txt"), "nested\n");
  });
  afterEach(() => fixture.cleanup());

  const ctx = (overrides = {}) => testContext(fixture.workspace, testConfig(fixture.root, overrides));

  it("reads a file and reports its size", async () => {
    const result = await fsRead.run({ path: "a.txt" }, ctx());
    expect(result.content[0]?.text).toContain("a.txt (14 bytes)");
    expect(result.content[0]?.text).toContain("one\ntwo\nthree");
  });

  it("pages through a file with offset and limit", async () => {
    const result = await fsRead.run({ path: "a.txt", offset: 2, limit: 1 }, ctx());
    const body = result.content[0]?.text ?? "";
    expect(body).toContain("two");
    expect(body).not.toContain("three");
  });

  it("rejects a zero or negative offset", async () => {
    await expect(fsRead.run({ path: "a.txt", offset: 0 }, ctx())).rejects.toThrow(/1-based/);
  });

  it("truncates a long read on a line boundary", async () => {
    const long = `${"line of text\n".repeat(500)}`;
    await fsp.writeFile(path.join(fixture.root, "long.txt"), long);
    const result = await fsRead.run(
      { path: "long.txt" },
      ctx({ limits: { ...testConfig(fixture.root).limits, maxReadBytes: 200 } }),
    );
    const part = result.content[0]!;
    expect(part.truncated).toBe(true);
    expect(part.text).toMatch(/truncated/);
    // Ends on a line break, so the model never sees half a line.
    const shown = part.text.split("\n\n[webmcp")[0] ?? "";
    expect(shown.endsWith("line of text\n")).toBe(true);
  });

  it("refuses to read outside the workspace", async () => {
    await expect(fsRead.run({ path: "../outside/x" }, ctx())).rejects.toThrow();
  });

  it("writes a new file", async () => {
    const result = await fsWrite.run({ path: "new.txt", content: "hi" }, ctx());
    expect(result.content[0]?.text).toContain("Created new.txt");
    expect(await fsp.readFile(path.join(fixture.root, "new.txt"), "utf8")).toBe("hi");
  });

  it("appends without losing what was there", async () => {
    await fsWrite.run({ path: "a.txt", content: "four\n", mode: "append" }, ctx());
    expect(await fsp.readFile(path.join(fixture.root, "a.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\n");
  });

  it("creates parent directories only when asked", async () => {
    await expect(fsWrite.run({ path: "x/y/z.txt", content: "q" }, ctx())).rejects.toThrow();
    await fsWrite.run({ path: "x/y/z.txt", content: "q", create_dirs: true }, ctx());
    expect(await fsp.readFile(path.join(fixture.root, "x/y/z.txt"), "utf8")).toBe("q");
  });

  it("refuses an over-limit write at validate time", () => {
    const context = ctx({ limits: { ...testConfig(fixture.root).limits, maxWriteBytes: 4 } });
    expect(() => fsWrite.validate?.({ path: "big.txt", content: "toolong" }, context)).toThrow(
      /limit is 4/,
    );
  });

  it("rejects an unknown write mode", () => {
    expect(() => fsWrite.validate?.({ path: "a.txt", content: "x", mode: "clobber" }, ctx())).toThrow(
      /unknown mode/,
    );
  });

  it("lists a directory, marking subdirectories", async () => {
    const body = (await fsList.run({}, ctx())).content[0]?.text ?? "";
    expect(body).toContain("a.txt");
    expect(body).toContain("sub/");
  });

  it("walks recursively when asked and skips node_modules", async () => {
    await fsp.mkdir(path.join(fixture.root, "node_modules", "pkg"), { recursive: true });
    const body = (await fsList.run({ recursive: true }, ctx())).content[0]?.text ?? "";
    expect(body).toContain("sub/b.txt");
    expect(body).toContain("node_modules/  (skipped)");
    expect(body).not.toContain("node_modules/pkg");
  });

  it("stops at the entry limit rather than dumping a huge tree", async () => {
    for (let i = 0; i < 30; i++) await fsp.writeFile(path.join(fixture.root, `f${i}.txt`), "x");
    const body = (await fsList.run(
      {},
      ctx({ limits: { ...testConfig(fixture.root).limits, maxListEntries: 5 } }),
    )).content[0]?.text ?? "";
    expect(body).toContain("stopped at 5 entries");
  });

  it("summarizes a call the way the approval prompt will show it", () => {
    expect(fsWrite.summarize({ path: "a.txt", content: "12345" })).toBe("Write a.txt (5 bytes)");
    expect(fsWrite.summarize({ path: "a.txt", content: "1", mode: "append" })).toBe(
      "Append to a.txt (1 bytes)",
    );
  });
});

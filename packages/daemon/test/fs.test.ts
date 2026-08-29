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
    // The notice now names the range and the resume offset rather than saying
    // only "truncated", which left the model to guess where to continue.
    expect(part.text).toMatch(/showed lines 1-\d+ .*Continue with/s);
    // Ends on a line break, so the model never sees half a line.
    const shown = part.text.split("\n[webmcp")[0] ?? "";
    expect(shown.endsWith("line of text\n")).toBe(true);
  });

  describe("paging a long file", () => {
    const LINES = 3_000;
    const big = () => Array.from({ length: LINES }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n") + "\n";
    const small = { limits: { maxReadBytes: 2_048, maxWriteBytes: 1_048_576, maxListEntries: 100, approvalTimeoutMs: 1_000, downstreamTimeoutMs: 1_000 } };

    beforeEach(async () => {
      await fsp.writeFile(path.join(fixture.root, "big.txt"), big());
    });

    it("reaches a line far past the read budget", async () => {
      // The bug: the file was read from byte zero up to a fixed cap and lines
      // were sliced from *that*, so anything beyond it was unreachable by any
      // offset — while the tool description told the model to page with one.
      const result = await fsRead.run({ path: "big.txt", offset: 2_000, limit: 2 }, ctx(small));
      expect(result.content[0]?.text).toContain("line 1999 ");
      expect(result.content[0]?.text).toContain("line 2000 ");
    });

    it("walks the whole file in pages, covering every line exactly once", async () => {
      const seen: string[] = [];
      let offset = 1;
      for (let page = 0; page < 500; page++) {
        const body = (await fsRead.run({ path: "big.txt", offset }, ctx(small))).content[0]!.text;
        if (body.includes("past the end")) break;
        seen.push(...body.split("\n").filter((l) => l.startsWith("line ")));
        const next = /"offset": (\d+)\}/.exec(body);
        if (next === null) break;
        offset = Number(next[1]);
      }
      expect(seen).toHaveLength(LINES);
      expect(seen[0]).toContain("line 0 ");
      expect(seen[LINES - 1]).toContain(`line ${LINES - 1} `);
      // No line delivered twice: an off-by-one in the resume offset would show
      // up here as a duplicate or a hole rather than as a wrong total.
      expect(new Set(seen).size).toBe(LINES);
    });

    it("names the resume offset instead of only saying it truncated", async () => {
      // "Truncated" with no next offset leaves the model to guess one, and the
      // old notice reported the internal read cap as the denominator — a 271KB
      // file described as 4096 bytes reads as "you have half of it".
      const body = (await fsRead.run({ path: "big.txt" }, ctx(small))).content[0]!.text;
      expect(body).toMatch(/showed lines 1-\d+ of big\.txt \(\d{5,} bytes\)/);
      expect(body).toMatch(/Continue with \{"path": "big.txt", "offset": \d+\}/);
    });

    /**
     * The case that escaped the budget entirely. Emitting at least one line
     * whatever its size sounds harmless until the file *is* one line: a
     * minified bundle or a single-line JSON blob came back whole, ignoring
     * `maxReadBytes`, and went straight into the composer.
     */
    it("cuts a single line that is longer than the whole budget", async () => {
      await fsp.writeFile(path.join(fixture.root, "one-line.json"), `${"x".repeat(200_000)}\n`);
      const body = (await fsRead.run({ path: "one-line.json" }, ctx(small))).content[0]!;

      expect(body.text.length).toBeLessThan(10_000);
      expect(body.truncated).toBe(true);
      // And it says the rest is not reachable by paging, rather than offering a
      // resume offset that would silently skip the remainder of the line.
      expect(body.text).toMatch(/longer than the 2048-byte result budget/);
      expect(body.text).not.toContain('"offset"');
    });

    it("says so when the offset is past the end, rather than returning nothing", async () => {
      // A bare header reads as "the file is empty here", which is what sent a
      // model round in circles paging a file it had already finished.
      const body = (await fsRead.run({ path: "big.txt", offset: 99_999 }, ctx(small))).content[0]!.text;
      expect(body).toContain(`has ${LINES} lines`);
      expect(body).not.toMatch(/^.*\n$/s);
    });

    it("keeps multi-byte characters intact across chunk boundaries", async () => {
      // The scan reads in 64KB chunks; splitting a buffer mid-code-point and
      // decoding each half is how a reader like this corrupts non-ASCII text.
      const line = `행 가나다 ${"가".repeat(40)}`;
      await fsp.writeFile(path.join(fixture.root, "utf8.txt"), `${Array.from({ length: 4_000 }, () => line).join("\n")}\n`);
      const body = (await fsRead.run({ path: "utf8.txt", offset: 3_500, limit: 2 }, ctx(small))).content[0]!.text;
      expect(body).toContain(line);
      expect(body).not.toContain("\uFFFD");
    });

    it("returns a single over-long line rather than nothing at all", async () => {
      await fsp.writeFile(path.join(fixture.root, "one.txt"), `${"y".repeat(20_000)}\n`);
      const body = (await fsRead.run({ path: "one.txt" }, ctx(small))).content[0]!.text;
      expect(body).toContain("yyyy");
    });

    it("handles a last line with no trailing newline", async () => {
      await fsp.writeFile(path.join(fixture.root, "tail.txt"), "alpha\nbeta\ngamma");
      const body = (await fsRead.run({ path: "tail.txt", offset: 3 }, ctx())).content[0]!.text;
      expect(body).toContain("gamma");
      expect(body).not.toContain("past the end");
    });
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

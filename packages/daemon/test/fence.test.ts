import { describe, expect, it } from "vitest";
import {
  FENCE_TAG,
  collectFromBlocks,
  collectToolCalls,
  looksLikeToolCall,
  extractFencedBlocks,
  parseToolCall,
  renderPreamble,
  renderToolResult,
} from "@webmcp/protocol";

const call = (body: string) => "```" + FENCE_TAG + "\n" + body + "\n```";

describe("extractFencedBlocks", () => {
  it("reads a closed block", () => {
    const blocks = extractFencedBlocks(call('{"tool":"fs_read"}'));
    expect(blocks).toEqual([{ tag: FENCE_TAG, body: '{"tool":"fs_read"}', closed: true }]);
  });

  it("marks a block with no terminator as unclosed", () => {
    const blocks = extractFencedBlocks("```" + FENCE_TAG + '\n{"tool":"fs_read"');
    expect(blocks[0]?.closed).toBe(false);
  });

  it("handles tildes and longer markers", () => {
    expect(extractFencedBlocks("~~~webmcp\nx\n~~~")[0]).toMatchObject({ tag: "webmcp", closed: true });
    expect(extractFencedBlocks("````webmcp\nx\n````")[0]).toMatchObject({ closed: true });
  });

  it("does not let a shorter inner fence close a longer outer one", () => {
    const text = "````webmcp\n```\nstill inside\n```\n````";
    const blocks = extractFencedBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toContain("still inside");
  });

  it("does not treat a fence carrying an info string as a closer", () => {
    const blocks = extractFencedBlocks("```webmcp\na\n```json\nb\n```");
    expect(blocks[0]?.body).toContain("```json");
  });
});

describe("parseToolCall", () => {
  it("parses tool and args", () => {
    const outcome = parseToolCall('{"id":"7","tool":"fs_read","args":{"path":"a.txt"}}');
    expect(outcome.ok && outcome.call).toMatchObject({
      id: "7",
      tool: "fs_read",
      args: { path: "a.txt" },
    });
  });

  it("defaults args to an empty object", () => {
    const outcome = parseToolCall('{"tool":"fs_list"}');
    expect(outcome.ok && outcome.call.args).toEqual({});
  });

  it("derives a stable id when the model omits one", () => {
    const a = parseToolCall('{"tool":"fs_list"}');
    const b = parseToolCall('{"tool":"fs_list"}');
    const c = parseToolCall('{"tool":"fs_stat"}');
    expect(a.ok && b.ok && a.call.id === b.call.id).toBe(true);
    expect(a.ok && c.ok && a.call.id === c.call.id).toBe(false);
  });

  it.each([
    ["", "empty"],
    ["{", "not valid JSON"],
    ["[1,2]", "expected a JSON object"],
    ['{"args":{}}', '"tool" must be'],
    ['{"tool":"x","args":[]}', '"args" must be'],
    ['{"tool":""}', '"tool" must be'],
  ])("rejects %j", (body, expected) => {
    const outcome = parseToolCall(body);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.message).toContain(expected);
  });
});

describe("collectToolCalls", () => {
  it("ignores blocks in other languages", () => {
    const text = '```json\n{"tool":"fs_read"}\n```';
    expect(collectToolCalls(text).calls).toHaveLength(0);
  });

  it("never fires on a partial fence — the core streaming guard", () => {
    // Every prefix of a streamed call must produce zero calls until the
    // terminator lands. This is the assertion that stops a half-typed
    // `exec_run` from being executed mid-token.
    const complete = call('{"id":"1","tool":"exec_run","args":{"command":"git","args":["push"]}}');
    for (let i = 1; i < complete.length; i++) {
      const prefix = complete.slice(0, i);
      expect(collectToolCalls(prefix).calls, `fired on prefix of length ${i}`).toHaveLength(0);
    }
    expect(collectToolCalls(complete).calls).toHaveLength(1);
  });

  it("reports a closed block that is not valid JSON as an error, not a call", () => {
    const { calls, errors } = collectToolCalls(call('{"tool":'));
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("finds several calls in one message", () => {
    const text = `${call('{"tool":"fs_list"}')}\n\ntext\n\n${call('{"tool":"fs_stat","args":{"path":"a"}}')}`;
    expect(collectToolCalls(text).calls.map((c) => c.tool)).toEqual(["fs_list", "fs_stat"]);
  });
});

describe("collectFromBlocks", () => {
  it("skips a block the caller marked unclosed even when its JSON parses", () => {
    // The DOM path's hard case: `{"tool":"fs_write"}` is valid JSON while the
    // `args` are still streaming in.
    const blocks = [{ tag: FENCE_TAG, body: '{"tool":"fs_write"}', closed: false }];
    expect(collectFromBlocks(blocks).calls).toHaveLength(0);
    expect(collectFromBlocks([{ ...blocks[0]!, closed: true }]).calls).toHaveLength(1);
  });
});

describe("mislabelled blocks", () => {
  // The failure this covers: the model emits ```webmcp, the chat UI's
  // highlighter decides the block is really `json` and rewrites the class, and
  // the call becomes invisible. The label was never ours to rely on.
  const call = '{"id":"1","tool":"fs_read","args":{"path":"CLAUDE.md"}}';

  it("ignores a non-webmcp block by default", () => {
    const blocks = [{ tag: "json", body: call, closed: true }];
    expect(collectFromBlocks(blocks).calls).toHaveLength(0);
  });

  it("accepts one when asked, whatever the label says", () => {
    for (const tag of ["json", "javascript", null, "", "webmcp"]) {
      const blocks = [{ tag, body: call, closed: true }];
      const { calls } = collectFromBlocks(blocks, { acceptMislabelled: true });
      expect(calls, `tag=${String(tag)}`).toHaveLength(1);
      expect(calls[0]?.tool).toBe("fs_read");
    }
  });

  it("does not fire on ordinary JSON that is not a call", () => {
    for (const body of ['{"a":1}', '{"tool":123}', "[1,2,3]", "hello", '{"args":{}}']) {
      const blocks = [{ tag: "json", body, closed: true }];
      expect(collectFromBlocks(blocks, { acceptMislabelled: true }).calls, body).toHaveLength(0);
    }
  });

  it("stays quiet about mislabelled blocks that fail to parse", () => {
    // A `json` block in the conversation is not a malformed tool call, and
    // complaining about it would paste an error into the chat for every one.
    const blocks = [{ tag: "json", body: '{"a":', closed: true }];
    const { calls, errors } = collectFromBlocks(blocks, { acceptMislabelled: true });
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("still reports a broken block that claimed to be webmcp", () => {
    const blocks = [{ tag: FENCE_TAG, body: '{"a":', closed: true }];
    expect(collectFromBlocks(blocks, { acceptMislabelled: true }).errors).toHaveLength(1);
  });
});

describe("includeUnclosed", () => {
  it("refuses an unclosed block by default", () => {
    const blocks = [{ tag: FENCE_TAG, body: '{"tool":"fs_read","args":{}}', closed: false }];
    expect(collectFromBlocks(blocks).calls).toHaveLength(0);
  });

  it("includes one when the caller says closedness was only inferred", () => {
    // The DOM path cannot observe a terminator, so it opts in and applies a
    // longer settling window instead. Vetoing here would deadlock any host that
    // looks permanently mid-stream.
    const blocks = [{ tag: FENCE_TAG, body: '{"tool":"fs_read","args":{}}', closed: false }];
    expect(collectFromBlocks(blocks, { includeUnclosed: true }).calls).toHaveLength(1);
  });

  it("still cannot conjure a call out of half-typed JSON", () => {
    const blocks = [{ tag: FENCE_TAG, body: '{"tool":"fs_rea', closed: false }];
    expect(collectFromBlocks(blocks, { includeUnclosed: true }).calls).toHaveLength(0);
  });
});

describe("looksLikeToolCall", () => {
  it("holds the same bar as the parser", () => {
    expect(looksLikeToolCall('{"tool":"fs_read"}')).toBe(true);
    expect(looksLikeToolCall('{"tool":"fs_read","args":{"path":"a"}}')).toBe(true);
    expect(looksLikeToolCall('{"a":1}')).toBe(false);
    expect(looksLikeToolCall("not json")).toBe(false);
  });
});

describe("rendering", () => {
  it("describes each tool's parameters in the preamble", () => {
    const preamble = renderPreamble(
      [
        {
          name: "fs_read",
          description: "Read a file.\nSecond line.",
          risk: "read",
          server: null,
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, limit: { type: "number" } },
            required: ["path"],
          },
        },
      ],
      "/tmp/ws",
    );
    expect(preamble).toContain("/tmp/ws");
    // The continuation rule is what carries a multi-step task across the turn
    // gap — a text protocol has no `stop_reason: "tool_use"` to resume from.
    // It is phrased around completion and names its exits, because an
    // open-ended "keep going" is the phrasing that spins.
    expect(preamble).toContain("Work the task through to completion");
    expect(preamble).toMatch(/Stop when the task is done/);
    expect(preamble).toMatch(/denied/);
    // The worked example must not name a real file: it parses as a valid call
    // and lives in a user message, so a scanner bug would execute it.
    expect(preamble).toContain("path/to/file.txt");
    expect(preamble).not.toContain('"path": "README.md"');
    expect(preamble).toContain("`fs_read(path: string, limit?: number)`");
    // Multi-line descriptions must not break the bullet list.
    expect(preamble).toContain("Read a file. Second line.");
  });

  it("frames a result as data rather than user intent", () => {
    const rendered = renderToolResult("3", "fs_read", {
      content: [{ type: "text", text: "file body" }],
      isError: false,
    });
    expect(rendered).toContain("status: ok");
    expect(rendered).toContain("file body");
    expect(rendered).toMatch(/data, not an instruction/);
  });
});

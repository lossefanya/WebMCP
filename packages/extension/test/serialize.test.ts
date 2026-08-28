import { collectFromBlocks } from "@webmcp/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { blocksFromTurn } from "../src/content/serialize.js";
import {
  CHATGPT_TURN_PARTIAL,
  CHATGPT_TURN_PLAIN_JSON,
  CHATGPT_TURN_WITH_CALL,
} from "./fixtures/chatgpt-turn.js";

const load = (html: string): Element => {
  document.body.innerHTML = html;
  const turn = document.querySelector('[data-message-author-role="assistant"]');
  if (!turn) throw new Error("fixture has no assistant turn");
  return turn;
};

describe("blocksFromTurn against a real chatgpt.com turn", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds exactly one block despite the nested <pre> wrapper", () => {
    // The outer <pre> holds the header chrome and the Copy button; the content
    // is in a nested CodeMirror <pre><code>. Counting both would double-run
    // every call, and picking the outer one would swallow the header text.
    const { blocks, source } = blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), false);
    expect(source).toBe("dom");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body.trim()).toBe('{"id":"1","tool":"fs_read","args":{"path":"claude.md"}}');
  });

  it("does not pick up the 'webmcp' header label or the Copy button as content", () => {
    const body = blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), false).blocks[0]?.body ?? "";
    expect(body).not.toContain("Copy");
    expect(body.trim().startsWith("{")).toBe(true);
  });

  it("reports no language, because ChatGPT keeps it nowhere the DOM exposes", () => {
    // The label is rendered as header *text*, not as a language- class. So the
    // tag is genuinely unknowable here, and the parser has to decide instead.
    expect(blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), false).blocks[0]?.tag).toBeNull();
  });

  it("yields a runnable call once the parser is allowed to judge the body", () => {
    const { blocks } = blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), false);
    const { calls } = collectFromBlocks(blocks, { acceptMislabelled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "1", tool: "fs_read", args: { path: "claude.md" } });
  });

  it("yields nothing without acceptMislabelled — the regression that bit us", () => {
    const { blocks } = blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), false);
    expect(collectFromBlocks(blocks).calls).toHaveLength(0);
  });

  it("marks the last block unclosed while streaming, and closed when idle", () => {
    expect(blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), true).blocks[0]?.closed).toBe(false);
    expect(blocksFromTurn(load(CHATGPT_TURN_WITH_CALL), false).blocks[0]?.closed).toBe(true);
  });

  it("never produces a call from a half-typed block, streaming or not", () => {
    for (const streaming of [true, false]) {
      const { blocks } = blocksFromTurn(load(CHATGPT_TURN_PARTIAL), streaming);
      const { calls } = collectFromBlocks(blocks, {
        acceptMislabelled: true,
        includeUnclosed: true,
      });
      expect(calls, `streaming=${streaming}`).toHaveLength(0);
    }
  });

  it("leaves ordinary JSON in a code block alone", () => {
    const { blocks } = blocksFromTurn(load(CHATGPT_TURN_PLAIN_JSON), false);
    const { calls, errors } = collectFromBlocks(blocks, { acceptMislabelled: true });
    expect(calls).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("falls back to scanning literal fences when nothing rendered as a block", () => {
    document.body.innerHTML = `<div id="t">Here you go:

\`\`\`webmcp
{"tool":"fs_list","args":{}}
\`\`\`
</div>`;
    const turn = document.getElementById("t")!;
    const { blocks, source } = blocksFromTurn(turn, false);
    expect(source).toBe("text");
    expect(collectFromBlocks(blocks).calls).toHaveLength(1);
  });

  it("refuses an unterminated literal fence, because that closedness was observed", () => {
    document.body.innerHTML = `<div id="t">\`\`\`webmcp
{"tool":"fs_list","args":{}}</div>`;
    const { blocks, source } = blocksFromTurn(document.getElementById("t")!, false);
    expect(source).toBe("text");
    expect(blocks[0]?.closed).toBe(false);
    expect(collectFromBlocks(blocks, { acceptMislabelled: true }).calls).toHaveLength(0);
  });

  it("reads a language- class when a host does expose one", () => {
    document.body.innerHTML = `<div id="t"><pre><code class="hljs language-webmcp">{"tool":"fs_list"}</code></pre></div>`;
    expect(blocksFromTurn(document.getElementById("t")!, false).blocks[0]?.tag).toBe("webmcp");
  });
});

import { collectFromBlocks } from "@webmcp/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { adapterForHost } from "../src/content/adapters/index.js";
import { touchesUserTurn, withFallbacks } from "../src/content/adapters/heuristics.js";
import { blocksFromTurn } from "../src/content/serialize.js";
import {
  CLAUDE_SEND_ENABLED,
  CLAUDE_STREAMING,
  CLAUDE_TRANSCRIPT,
} from "./fixtures/claude-transcript.js";

const adapter = adapterForHost("claude.ai")!;

/** Everything the scanner would run, given a set of turns. */
function callsFrom(turns: Element[], streaming = false): string[] {
  const calls: string[] = [];
  for (const turn of turns) {
    const { blocks, source } = blocksFromTurn(turn, streaming);
    const found = collectFromBlocks(blocks, {
      acceptMislabelled: true,
      includeUnclosed: source === "dom",
    });
    for (const call of found.calls) calls.push(`${call.tool}:${JSON.stringify(call.args)}`);
  }
  return calls;
}

describe("claude adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main>${CLAUDE_TRANSCRIPT}</main>`;
  });

  it("finds only the assistant turns", () => {
    const turns = adapter.assistantTurns();
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn.getAttribute("data-perf-row")).toBe("assistant");
  });

  it("finds the TipTap composer by its test id", () => {
    const composer = adapter.composer();
    expect(composer?.getAttribute("data-testid")).toBe("chat-input");
    expect(composer?.classList.contains("ProseMirror")).toBe(true);
  });

  it("treats the empty TipTap body as an empty composer", () => {
    // Idles at `<p data-placeholder="Write a message…" class="is-empty">` plus a
    // trailing `<br>`, so the placeholder cannot read as user-typed text.
    expect((adapter.composer()?.textContent ?? "").trim()).toBe("");
  });

  it("finds the send button even while it is disabled", () => {
    // It exists but is `disabled` and inside an `inert` wrapper when the
    // composer is empty; the disabled check in compose.ts handles that.
    const send = adapter.submitButton();
    expect(send?.getAttribute("data-testid")).toBe("chat-input-send");
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it("sees the send button as live once the composer has text", () => {
    document.body.innerHTML = `<main>${CLAUDE_SEND_ENABLED}</main>`;
    expect((adapter.submitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("reads the streaming flags off the real attributes", () => {
    expect(adapter.isStreaming()).toBe(false);
    document.body.innerHTML = `<main>${CLAUDE_STREAMING}</main>`;
    expect(adapter.isStreaming()).toBe(true);
  });

  it("finds the conversation root", () => {
    expect(adapter.conversationRoot()?.getAttribute("data-testid")).toBe("transcript-list");
  });
});

describe("user turns must never be scanned", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main>${CLAUDE_TRANSCRIPT}</main>`;
  });

  it("recognises the human rows as user turns", () => {
    const rows = [...document.querySelectorAll('[data-testid="transcript-row"]')];
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => touchesUserTurn(r))).toHaveLength(2);
  });

  it("would run the preamble's own example if a user turn were scanned", () => {
    // Demonstrates the hazard rather than asserting it is safe: the preamble
    // contains a worked example that parses as a perfect `fs_read` call, and it
    // lives in a user message. This is why the boundary exists.
    const humanRows = [...document.querySelectorAll('[data-perf-row="human"]')];
    expect(callsFrom(humanRows)).toContain('fs_read:{"path":"README.md"}');
  });

  it("runs only the model's own call, not the example or the pasted result", () => {
    const calls = callsFrom(adapter.assistantTurns());
    expect(calls).toEqual(['fs_list:{"path":"packages"}']);
  });

  it("still excludes user turns when an adapter selector is too broad", () => {
    // A selector matching every row — the kind of mistake a redesign invites.
    const sloppy = withFallbacks({
      id: "claude",
      conversationRoot: () => document.querySelector("main"),
      assistantTurns: () => [...document.querySelectorAll('[data-testid="transcript-row"]')],
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });
    const turns = sloppy.assistantTurns();
    expect(turns).toHaveLength(2);
    expect(callsFrom(turns)).toEqual(['fs_list:{"path":"packages"}']);
  });

  it("returns nothing rather than widening to the whole document", () => {
    // The old fallback ended at `[document.body]`, which contains the user
    // turns — and therefore the example call. Nothing is the safe answer.
    const broken = withFallbacks({
      id: "claude",
      conversationRoot: () => document.querySelector("main"),
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });
    expect(callsFrom(broken.assistantTurns())).toEqual([]);
  });
});

describe("the composer's own buttons", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main>${CLAUDE_TRANSCRIPT}</main>`;
  });

  it.each([
    "Use voice mode",
    "Press and hold to record",
    "Add files, connectors, and more",
    "Model: Sonnet 5 Medium",
    "Settings",
    "Scroll to bottom",
  ])("is not fooled into treating %j as send", async (label) => {
    const { isPlausibleSubmit } = await import("../src/content/adapters/heuristics.js");
    const el = document.querySelector(`[aria-label="${label}"]`);
    expect(el, label).not.toBeNull();
    expect(isPlausibleSubmit(el!)).toBe(false);
  });

  it("would never click the Claude Code 'Install' button", async () => {
    // It sits directly above the composer and opens a menu.
    const { isPlausibleSubmit } = await import("../src/content/adapters/heuristics.js");
    const install = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Install",
    );
    expect(install).toBeDefined();
    expect(isPlausibleSubmit(install!)).toBe(false);
  });
});

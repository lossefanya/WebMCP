import { beforeEach, describe, expect, it } from "vitest";
import { adapterForHost } from "../src/content/adapters/index.js";
import { guessComposer, guessSubmitButton, withFallbacks } from "../src/content/adapters/heuristics.js";
import { insertAndSubmit } from "../src/content/compose.js";
import { blocksFromTurn } from "../src/content/serialize.js";
import { collectFromBlocks } from "@webmcp/protocol";
import { touchesUserTurn } from "../src/content/adapters/heuristics.js";
import { GEMINI_WITH_SEND_BUTTON, GEMINI_ZERO_STATE } from "./fixtures/gemini-input.js";
import { GEMINI_STREAMING, GEMINI_TRANSCRIPT } from "./fixtures/gemini-transcript.js";

/** jsdom gives everything a 0x0 rect; the heuristics filter on real geometry. */
function giveLayout(selector: string, rect: { width: number; height: number; top: number }): void {
  for (const el of document.querySelectorAll(selector)) {
    el.getBoundingClientRect = () =>
      ({
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: 0,
        right: rect.width,
        bottom: rect.top + rect.height,
        x: 0,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

const adapter = adapterForHost("gemini.google.com")!;

describe("gemini adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = GEMINI_ZERO_STATE;
  });

  it("claims gemini.google.com and nothing else Google-shaped", () => {
    expect(adapterForHost("gemini.google.com")?.id).toBe("gemini");
    expect(adapterForHost("google.com")).toBeNull();
    expect(adapterForHost("mail.google.com")).toBeNull();
    expect(adapterForHost("gemini.google.com.evil.test")).toBeNull();
  });

  it("finds the conversation root by its data-test-id", () => {
    expect(adapter.conversationRoot()?.tagName.toLowerCase()).toBe("infinite-scroller");
  });

  it("finds the Quill editor as the composer", () => {
    const composer = adapter.composer();
    expect(composer?.classList.contains("ql-editor")).toBe(true);
    expect(composer?.getAttribute("aria-label")).toBe("Enter a prompt for Gemini");
  });

  it("does not mistake Quill's hidden clipboard for the composer", () => {
    // `div.ql-clipboard` is also contenteditable and sits next to the real one.
    // Typing into it would go nowhere at all.
    expect(adapter.composer()?.classList.contains("ql-clipboard")).toBe(false);
  });

  it("treats the empty Quill body as an empty composer", () => {
    // Quill's empty state is `<p><br></p>`, and the placeholder lives in
    // `data-placeholder`. If either read as text, every send would be deferred
    // forever as "the user is typing".
    const composer = adapter.composer()!;
    expect((composer.textContent ?? "").trim()).toBe("");
  });

  it("reports no send button in the zero state, rather than the wrong one", () => {
    // Gemini has no send button until there is text. The nearby buttons are
    // Upload, the model picker and the mic.
    expect(adapter.submitButton()).toBeNull();
  });

  it("finds the send button once it appears", () => {
    document.body.innerHTML = GEMINI_WITH_SEND_BUTTON;
    expect(adapter.submitButton()?.getAttribute("aria-label")).toBe("Send message");
  });

  it("is not streaming on a zero-state page", () => {
    expect(adapter.isStreaming()).toBe(false);
  });
});

describe("submit-button heuristic safety on gemini", () => {
  beforeEach(() => {
    document.body.innerHTML = GEMINI_ZERO_STATE;
    giveLayout("div.ql-editor", { width: 700, height: 48, top: 700 });
    giveLayout("button", { width: 40, height: 40, top: 700 });
  });

  it("refuses to guess rather than clicking the microphone", () => {
    // The regression this pins: the heuristic used to fall back to "the last
    // visible button in the composer's container". Here that is Dictate —
    // clicking it starts recording the user instead of sending a message.
    const composer = guessComposer();
    expect(guessSubmitButton(composer)).toBeNull();
  });

  it("still finds a genuine send button when one exists", () => {
    document.body.innerHTML = GEMINI_WITH_SEND_BUTTON;
    giveLayout("div.ql-editor", { width: 700, height: 48, top: 700 });
    giveLayout("button", { width: 40, height: 40, top: 700 });
    expect(guessSubmitButton(guessComposer())?.getAttribute("aria-label")).toBe("Send message");
  });

  it.each([
    "Dictate (⌘⇧D)",
    "Upload and tools",
    "Open mode picker, currently Flash",
    "Copy",
    "Stop response",
    "Attach file",
    "Regenerate",
  ])("never picks a button labelled %j", (label) => {
    document.body.innerHTML = `<form><textarea></textarea><button aria-label="${label}"></button></form>`;
    giveLayout("textarea", { width: 600, height: 50, top: 700 });
    giveLayout("button", { width: 40, height: 40, top: 700 });
    expect(guessSubmitButton(guessComposer())).toBeNull();
  });

  it("guesses the composer even with the named selectors gone", () => {
    const wrapped = withFallbacks({
      id: "gemini",
      conversationRoot: () => null,
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });
    expect(wrapped.composer()?.classList.contains("ql-editor")).toBe(true);
    expect([...wrapped.fellBackOn]).toContain("composer");
  });
});

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

describe("gemini adapter against a real transcript", () => {
  beforeEach(() => {
    document.body.innerHTML = GEMINI_TRANSCRIPT;
  });

  it("finds one turn per model response", () => {
    const turns = adapter.assistantTurns();
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn.closest("model-response")).not.toBeNull();
  });

  it("does not use .conversation-container, which holds both sides", () => {
    // The container wraps <user-query> and <model-response> together, so it can
    // never be a safe assistant-turn selector.
    const containers = [...document.querySelectorAll(".conversation-container")];
    expect(containers).toHaveLength(2);
    for (const container of containers) expect(touchesUserTurn(container)).toBe(true);
    for (const turn of adapter.assistantTurns()) expect(touchesUserTurn(turn)).toBe(false);
  });

  it("extracts the call from Gemini's code-block element", () => {
    expect(callsFrom(adapter.assistantTurns())).toEqual(['fs_read:{"path":"README.md"}']);
  });

  it("does not read the header label as the language", () => {
    // Gemini shows "Code snippet" / "Markdown" as header *text*, not a class, so
    // the tag is genuinely null and the parser must decide.
    const { blocks } = blocksFromTurn(adapter.assistantTurns()[0]!, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBeNull();
    expect(blocks[0]?.body).not.toContain("Code snippet");
  });

  it("leaves a file-content code block alone", () => {
    // The second response shows the written file back as a Markdown block.
    const second = adapter.assistantTurns()[1]!;
    const { blocks } = blocksFromTurn(second, false);
    expect(blocks[0]?.body).toContain("# Hello Gemini");
    expect(callsFrom([second])).toEqual([]);
  });

  it("reads streaming off aria-busy", () => {
    expect(adapter.isStreaming()).toBe(false);
    document.body.innerHTML = GEMINI_STREAMING;
    expect(adapter.isStreaming()).toBe(true);
  });
});

describe("gemini user turns must never be scanned", () => {
  beforeEach(() => {
    document.body.innerHTML = GEMINI_TRANSCRIPT;
  });

  it("recognises user-query as a user turn", () => {
    const queries = [...document.querySelectorAll("user-query")];
    expect(queries).toHaveLength(2);
    for (const query of queries) expect(touchesUserTurn(query)).toBe(true);
  });

  it("would run the preamble's example if a user turn were scanned", () => {
    // Gemini's worse case: the preamble is rendered as plain-text paragraphs
    // with the literal ``` fences intact, so the *text* scanner finds a
    // complete, closed, valid call — no code block required.
    const preamble = document.querySelector("user-query")!;
    expect(callsFrom([preamble])).toContain('fs_read:{"path":"README.md"}');
  });

  it("does not mistake a pasted webmcp-result for a call", () => {
    const resultTurn = [...document.querySelectorAll("user-query")][1]!;
    expect(callsFrom([resultTurn])).toEqual([]);
  });

  it("runs only the model's own call across the whole page", () => {
    expect(callsFrom(adapter.assistantTurns())).toEqual(['fs_read:{"path":"README.md"}']);
  });
});

describe("gemini response-footer buttons", () => {
  beforeEach(() => {
    document.body.innerHTML = GEMINI_TRANSCRIPT;
  });

  it.each([
    "Download code",
    "Copy code",
    "Good response",
    "Bad response",
    "Show more options",
    "Upload and tools",
    "Open mode picker, currently Flash",
    "Dictate (⌘⇧D)",
  ])("never treats %j as a send button", async (label) => {
    const { isPlausibleSubmit } = await import("../src/content/adapters/heuristics.js");
    const el = document.querySelector(`button[aria-label="${label}"]`);
    expect(el, label).not.toBeNull();
    expect(isPlausibleSubmit(el!)).toBe(false);
  });

  it("still has no send button, and delivers via Enter", async () => {
    expect(adapter.submitButton()).toBeNull();

    const composer = document.querySelector("div.ql-editor") as HTMLElement;
    (document as unknown as { execCommand: unknown }).execCommand = (
      _c: string,
      _u: boolean,
      value: string,
    ) => {
      composer.textContent = value;
      return true;
    };
    const clicks: string[] = [];
    for (const el of document.querySelectorAll("button")) {
      el.addEventListener("click", () => clicks.push(el.getAttribute("aria-label") ?? "?"));
    }
    composer.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") composer.textContent = "";
    });

    const outcome = await insertAndSubmit(adapter, "tool output");
    expect(clicks).toEqual([]);
    expect(outcome.status).toBe("sent");
    expect(outcome.detail).toBe("pressed Enter");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { adapterForHost } from "../src/content/adapters/index.js";
import { withFallbacks } from "../src/content/adapters/heuristics.js";
import { allMatches, firstMatch } from "../src/content/adapters/types.js";
import { CHATGPT_TURN_WITH_CALL } from "./fixtures/chatgpt-turn.js";

describe("adapterForHost", () => {
  it.each([
    ["chatgpt.com", "chatgpt"],
    ["chat.openai.com", "chatgpt"],
    ["claude.ai", "claude"],
    ["www.perplexity.ai", "perplexity"],
    ["perplexity.ai", "perplexity"],
  ])("claims %s", (host, id) => {
    expect(adapterForHost(host)?.id).toBe(id);
  });

  it.each(["example.com", "notchatgpt.com", "chatgpt.com.evil.test", ""])(
    "does not claim %j",
    (host) => {
      expect(adapterForHost(host)).toBeNull();
    },
  );
});

describe("chatgpt adapter against the real turn", () => {
  const adapter = adapterForHost("chatgpt.com")!;

  beforeEach(() => {
    document.body.innerHTML = `<main>${CHATGPT_TURN_WITH_CALL}</main>`;
  });

  it("finds the assistant turn from the document, not from a root", () => {
    // The regression this pins: turns used to be queried *inside*
    // conversationRoot(), so one stale layout selector hid every turn and looked
    // exactly like "the model has not replied yet".
    const turns = adapter.assistantTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.getAttribute("data-message-id")).toBe("c138c12a-b184-4cbd-ae35-ebcb750f8840");
  });

  it("still finds turns when the conversation root selector matches nothing", () => {
    document.body.innerHTML = CHATGPT_TURN_WITH_CALL; // no <main> at all
    expect(adapter.assistantTurns()).toHaveLength(1);
  });

  it("resolves a conversation root without throwing on any selector", () => {
    // Every selector in an adapter's fallback list runs through querySelector,
    // and one the engine rejects would otherwise take down the content script.
    expect(() => adapter.conversationRoot()).not.toThrow();
    expect(adapter.conversationRoot()).not.toBeNull();
  });

  it("survives a selector the engine cannot parse", () => {
    const broken = withFallbacks({
      id: "broken",
      conversationRoot: () => firstMatch([":has-nonsense((", "main"]),
      assistantTurns: () => allMatches(["!!!invalid", '[data-message-author-role="assistant"]']),
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });
    expect(() => broken.conversationRoot()).not.toThrow();
    expect(broken.assistantTurns()).toHaveLength(1);
  });

  it("reports not streaming for a finished turn", () => {
    expect(adapter.isStreaming()).toBe(false);
  });

  it("reports streaming when the marker class is present", () => {
    document.body.innerHTML = `<main><div class="result-streaming">x</div></main>`;
    expect(adapter.isStreaming()).toBe(true);
  });

  it("does not mistake the code block's Copy button for a send button", () => {
    // The fixture's only button is "Copy". Treating it as send would click it
    // and silently drop the tool result.
    expect(adapter.submitButton()).toBeNull();
  });
});

/**
 * jsdom reports every element as 0x0, and the heuristics filter on real
 * geometry — correctly, since a 0x0 box is exactly what a hidden template looks
 * like in a browser. So the layout has to be supplied here.
 */
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

describe("withFallbacks", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("records which lookups needed a guess", () => {
    const wrapped = withFallbacks({
      id: "test",
      conversationRoot: () => null,
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });

    document.body.innerHTML = `<main><textarea></textarea>
      <button aria-label="Send message">go</button></main>`;
    giveLayout("textarea", { width: 600, height: 60, top: 700 });
    giveLayout("button", { width: 40, height: 40, top: 700 });

    wrapped.conversationRoot();
    wrapped.assistantTurns();
    wrapped.composer();
    wrapped.submitButton();

    expect([...wrapped.fellBackOn].sort()).toEqual([
      "assistantTurns",
      "composer",
      "conversationRoot",
      "submitButton",
    ]);
  });

  it("guesses the composer as the largest text box low on the page", () => {
    document.body.innerHTML = `
      <div contenteditable="true" id="tiny"></div>
      <div contenteditable="true" id="offscreen-big"></div>
      <textarea id="composer"></textarea>`;
    giveLayout("#tiny", { width: 100, height: 20, top: 800 });
    // Bigger in area, but at the very top of the page — a document editor, not
    // a chat composer.
    giveLayout("#offscreen-big", { width: 900, height: 300, top: 0 });
    giveLayout("#composer", { width: 700, height: 90, top: 820 });

    const wrapped = withFallbacks({
      id: "test",
      conversationRoot: () => null,
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });
    expect(wrapped.composer()?.id).toBe("composer");
  });

  it("prefers a named hit and records no fallback for it", () => {
    document.body.innerHTML = `<main><div id="real" contenteditable="true"></div></main>`;
    const real = document.getElementById("real") as HTMLElement;
    const wrapped = withFallbacks({
      id: "test",
      conversationRoot: () => document.querySelector("main"),
      assistantTurns: () => [real],
      isStreaming: () => false,
      composer: () => real,
      submitButton: () => real,
    });

    expect(wrapped.composer()).toBe(real);
    expect(wrapped.assistantTurns()).toEqual([real]);
    expect([...wrapped.fellBackOn]).toEqual([]);
  });
});

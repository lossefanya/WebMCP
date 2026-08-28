import { beforeEach, describe, expect, it, vi } from "vitest";
import { adapterForHost } from "../src/content/adapters/index.js";
import {
  guessComposer,
  guessSubmitButton,
  isPlausibleSubmit,
} from "../src/content/adapters/heuristics.js";
import { insertAndSubmit } from "../src/content/compose.js";
import { collectFromBlocks } from "@webmcp/protocol";
import { touchesUserTurn, withFallbacks } from "../src/content/adapters/heuristics.js";
import { blocksFromTurn } from "../src/content/serialize.js";
import { PERPLEXITY_WITH_SUBMIT, PERPLEXITY_ZERO_STATE } from "./fixtures/perplexity-input.js";
import { PERPLEXITY_SUBMIT_ENABLED, PERPLEXITY_THREAD } from "./fixtures/perplexity-thread.js";

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

const adapter = adapterForHost("perplexity.ai")!;

describe("perplexity adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = PERPLEXITY_ZERO_STATE;
  });

  it("finds the Lexical composer by its stable id", () => {
    expect(adapter.composer()?.id).toBe("ask-input");
    expect(adapter.composer()?.getAttribute("data-lexical-editor")).toBe("true");
  });

  it("finds the scroll container as the conversation root", () => {
    expect(adapter.conversationRoot()?.classList.contains("scrollable-container")).toBe(true);
  });

  it("treats the empty Lexical body as an empty composer", () => {
    // Lexical's empty state is `<p dir="auto"><br></p>`, and the placeholder is a
    // sibling `aria-hidden` div — so neither reads as user-typed text.
    expect((adapter.composer()?.textContent ?? "").trim()).toBe("");
  });

  it("reports no submit button in the zero state", () => {
    // Perplexity renders one only once there is text. Reporting null here is the
    // honest answer; guessing is what clicked voice mode.
    expect(adapter.submitButton()).toBeNull();
  });

  it("finds the submit button once it appears", () => {
    document.body.innerHTML = PERPLEXITY_WITH_SUBMIT;
    expect(adapter.submitButton()?.getAttribute("aria-label")).toBe("Submit");
  });

  it("is not streaming on a zero-state page", () => {
    expect(adapter.isStreaming()).toBe(false);
  });
});

describe("the buttons that are actually on the page", () => {
  beforeEach(() => {
    document.body.innerHTML = PERPLEXITY_ZERO_STATE;
  });

  const button = (label: string): Element => {
    const found = document.querySelector(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`fixture has no button labelled ${label}`);
    return found;
  };

  it.each(["Use voice mode", "Dictation", "Model", "Add files or tools"])(
    "vetoes %j as a send button",
    (label) => {
      expect(isPlausibleSubmit(button(label))).toBe(false);
    },
  );

  it("vetoes the Search and Computer mode toggles on structure, not wording", () => {
    // Neither carries an aria-label; "Computer" matches no plausible deny-list
    // word either. What settles it is `aria-pressed` — a send button is never a
    // toggle. This is why the guard checks ARIA before it checks labels.
    const toggles = [...document.querySelectorAll("button[aria-pressed]")];
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) expect(isPlausibleSubmit(toggle)).toBe(false);
  });

  it("vetoes menu triggers and disclosure buttons the same way", () => {
    // "Add files or tools" and "Model" both open menus; "Open sidebar" is a
    // disclosure. None of them are send buttons whatever they are called.
    for (const selector of [
      'button[aria-haspopup="menu"]',
      'button[aria-label="Open sidebar"]',
    ]) {
      for (const el of document.querySelectorAll(selector)) {
        expect(isPlausibleSubmit(el), selector).toBe(false);
      }
    }
  });

  it("allows a real Submit button", () => {
    document.body.innerHTML = PERPLEXITY_WITH_SUBMIT;
    expect(isPlausibleSubmit(button("Submit"))).toBe(true);
  });

  it("recognises the mic from its sprite reference alone", () => {
    // `#pplx-icon-microphone` is the only clue an icon-only button gives if the
    // aria-label is ever dropped.
    document.body.innerHTML = `<button><svg><use xlink:href="#pplx-icon-microphone"></use></svg></button>`;
    expect(isPlausibleSubmit(document.querySelector("button")!)).toBe(false);
  });
});

describe("the voice-mode regression", () => {
  beforeEach(() => {
    document.body.innerHTML = PERPLEXITY_ZERO_STATE;
    giveLayout("#ask-input", { width: 700, height: 48, top: 700 });
    giveLayout("button", { width: 32, height: 32, top: 700 });
  });

  it("does not offer 'Use voice mode' as a guessed send button", () => {
    // The reported bug: "Use voice mode" is the last button in the composer and
    // was picked by the old last-button-wins fallback.
    expect(guessSubmitButton(guessComposer())).toBeNull();
  });

  it("never clicks any button on the zero-state page", async () => {
    const clicks: string[] = [];
    for (const el of document.querySelectorAll("button")) {
      el.addEventListener("click", () =>
        clicks.push(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "?"),
      );
    }

    const composer = document.getElementById("ask-input") as HTMLElement;
    (document as unknown as { execCommand: unknown }).execCommand = (
      _c: string,
      _u: boolean,
      value: string,
    ) => {
      composer.textContent = value;
      return true;
    };
    composer.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") composer.textContent = "";
    });

    const outcome = await insertAndSubmit(adapter, "tool output");

    expect(clicks).toEqual([]);
    expect(outcome.status).toBe("sent");
    expect(outcome.detail).toBe("pressed Enter");
  });

  it("clicks Submit, and only Submit, once it exists", async () => {
    document.body.innerHTML = PERPLEXITY_WITH_SUBMIT;
    giveLayout("#ask-input", { width: 700, height: 48, top: 700 });
    giveLayout("button", { width: 32, height: 32, top: 700 });

    const clicks: string[] = [];
    for (const el of document.querySelectorAll("button")) {
      el.addEventListener("click", () => clicks.push(el.getAttribute("aria-label") ?? "?"));
    }

    const composer = document.getElementById("ask-input") as HTMLElement;
    (document as unknown as { execCommand: unknown }).execCommand = (
      _c: string,
      _u: boolean,
      value: string,
    ) => {
      composer.textContent = value;
      return true;
    };
    document
      .querySelector('button[aria-label="Submit"]')!
      .addEventListener("click", () => {
        composer.textContent = "";
      });

    const outcome = await insertAndSubmit(adapter, "tool output");
    expect(clicks).toEqual(["Submit"]);
    expect(outcome.status).toBe("sent");
  });
});

/* ------------------------------------------------------------------ */
/* the live thread                                                     */
/* ------------------------------------------------------------------ */

describe("perplexity adapter against a real thread", () => {
  beforeEach(() => {
    document.body.innerHTML = PERPLEXITY_THREAD;
  });

  it("finds one turn per answer, via data-workflow-final-text", () => {
    const turns = adapter.assistantTurns();
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn.hasAttribute("data-workflow-final-text")).toBe(true);
  });

  it("excludes the Copy/Share/thumbs footer, which is a sibling", () => {
    for (const turn of adapter.assistantTurns()) {
      expect(turn.querySelector("[data-workflow-text-footer]")).toBeNull();
      expect(turn.querySelector('button[aria-label="Helpful"]')).toBeNull();
    }
  });

  it("extracts the call from the figure/figcaption code block", () => {
    expect(callsFrom(adapter.assistantTurns())).toEqual(['fs_read:{"path":"readme.md"}']);
  });

  it("does not read the figcaption language label as content", () => {
    // The `<figcaption>` holds `<span>text</span>` and a Copy button, both
    // *outside* the `<code>` — so the innermost-wins rule keeps them out.
    const second = adapter.assistantTurns()[1]!;
    const { blocks } = blocksFromTurn(second, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tag).toBeNull();
    expect(blocks[0]?.body.trim()).toBe('{"id":"1","tool":"fs_read","args":{"path":"readme.md"}}');
    expect(blocks[0]?.body).not.toContain("Copy code");
  });

  it("finds the composer and its follow-up placeholder", () => {
    expect(adapter.composer()?.id).toBe("ask-input");
    expect(adapter.composer()?.getAttribute("aria-placeholder")).toBe("Ask a follow-up");
  });

  it("finds Submit, disabled while the composer is empty", () => {
    const submit = adapter.submitButton() as HTMLButtonElement;
    expect(submit?.getAttribute("aria-label")).toBe("Submit");
    expect(submit.disabled).toBe(true);
  });

  it("sees Submit as live once the composer has text", () => {
    document.body.innerHTML = PERPLEXITY_SUBMIT_ENABLED;
    expect((adapter.submitButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicks Submit, and only Submit", async () => {
    document.body.innerHTML = PERPLEXITY_SUBMIT_ENABLED;
    const composer = document.getElementById("ask-input") as HTMLElement;
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
    document.querySelector('button[aria-label="Submit"]')!.addEventListener("click", () => {
      composer.textContent = "";
    });

    const outcome = await insertAndSubmit(adapter, "tool output");
    expect(clicks).toEqual(["Submit"]);
    expect(outcome.status).toBe("sent");
  });
});

describe("perplexity user turns must never be scanned", () => {
  beforeEach(() => {
    document.body.innerHTML = PERPLEXITY_THREAD;
  });

  it("recognises the user bubbles, which carry no data attribute", () => {
    // Their only hooks are the Tailwind group name and the per-query buttons.
    const bubbles = [...document.querySelectorAll('[class*="user-bubble"]')];
    expect(bubbles.length).toBeGreaterThanOrEqual(2);
    for (const bubble of bubbles) expect(touchesUserTurn(bubble)).toBe(true);
  });

  it("would run the preamble's example if a user turn were scanned", () => {
    // The bubble text is a `whitespace-pre-line` span holding raw markdown with
    // the ``` fences intact, so the text scanner finds a complete valid call.
    const bubble = document.querySelector('[class*="user-bubble"]')!;
    expect(callsFrom([bubble])).toContain('fs_read:{"path":"path/to/file.txt"}');
  });

  it("runs only the model's own call across the whole thread", () => {
    expect(callsFrom(adapter.assistantTurns())).toEqual(['fs_read:{"path":"readme.md"}']);
  });

  it("keeps user turns out even when the adapter selector is too broad", () => {
    const sloppy = withFallbacks({
      id: "perplexity",
      conversationRoot: () => document.querySelector(".scrollable-container"),
      assistantTurns: () => [...document.querySelectorAll("div.flow-root, [class*='user-bubble']")],
      isStreaming: () => false,
      composer: () => null,
      submitButton: () => null,
    });
    for (const turn of sloppy.assistantTurns()) expect(touchesUserTurn(turn)).toBe(false);
  });
});

describe("thread-level buttons", () => {
  beforeEach(() => {
    document.body.innerHTML = PERPLEXITY_THREAD;
  });

  it.each([
    "Edit query",
    "Copy query",
    "Copy",
    "Share",
    "Helpful",
    "Not helpful",
    "More actions",
    "Copy code",
    "Scroll to end",
    "2 drafts",
    "Model",
    "Dictation",
    "Add files or tools",
  ])("never treats %j as a send button", (label) => {
    const el = document.querySelector(`button[aria-label="${label}"]`);
    expect(el, label).not.toBeNull();
    expect(isPlausibleSubmit(el!)).toBe(false);
  });

  it("allows the real Submit button", () => {
    expect(isPlausibleSubmit(document.querySelector('button[aria-label="Submit"]')!)).toBe(true);
  });
});

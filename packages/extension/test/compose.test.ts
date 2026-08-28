import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertAndSubmit } from "../src/content/compose.js";
import { isPlausibleSubmit } from "../src/content/adapters/heuristics.js";
import type { SiteAdapter } from "../src/content/adapters/types.js";

/**
 * jsdom has no `execCommand`, and these tests are not about the editor's
 * internals — they are about which element gets clicked. `insertText` is stubbed
 * to write the text and report success, which is what a real editor does.
 */
function stubExecCommand(target?: HTMLElement): void {
  (document as unknown as { execCommand: unknown }).execCommand = (
    _cmd: string,
    _ui: boolean,
    value: string,
  ) => {
    // jsdom does not focus a bare contenteditable div, so the target is passed
    // in rather than read off `document.activeElement`.
    const el = target ?? (document.querySelector("[contenteditable]") as HTMLElement | null);
    if (el) el.textContent = value;
    return true;
  };
}

function adapterFor(composer: () => HTMLElement | null, submit: () => HTMLElement | null): SiteAdapter {
  return {
    id: "test",
    conversationRoot: () => document.body,
    assistantTurns: () => [],
    isStreaming: () => false,
    composer,
    submitButton: submit,
  };
}

describe("isPlausibleSubmit", () => {
  const label = (attrs: string) => {
    document.body.innerHTML = `<button ${attrs}></button>`;
    return document.querySelector("button")!;
  };

  it.each([
    'aria-label="Dictate (⌘⇧D)"',
    'aria-label="Voice mode"',
    'aria-label="Dictation"',
    'aria-label="Copy"',
    'aria-label="Attach file"',
    'aria-label="Stop generating"',
    'aria-label="Open mode picker, currently Flash"',
    'data-testid="voice-mode-button"',
    'aria-label="New Thread"',
  ])("rejects %s", (attrs) => {
    expect(isPlausibleSubmit(label(attrs))).toBe(false);
  });

  it.each([
    'aria-label="Send message"',
    'aria-label="Submit"',
    'data-testid="submit-button"',
    'aria-label="Send"',
    "", // icon-only with no accessible name at all
  ])("allows %s", (attrs) => {
    expect(isPlausibleSubmit(label(attrs))).toBe(true);
  });

  it("reads an icon-font glyph name when that is the only hint", () => {
    document.body.innerHTML = `<button><mat-icon data-mat-icon-name="mic"></mat-icon></button>`;
    expect(isPlausibleSubmit(document.querySelector("button")!)).toBe(false);
  });
});

describe("insertAndSubmit", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    stubExecCommand();
  });

  it("refuses to click a microphone and falls back to Enter", async () => {
    // The regression this pins, reported on perplexity.ai: a hand-written
    // adapter selector matched the mic button, and clicking it started
    // recording the user instead of sending the message.
    document.body.innerHTML = `
      <div id="composer" contenteditable="true"></div>
      <button id="mic" aria-label="Dictation"></button>`;
    const composer = document.getElementById("composer") as HTMLElement;
    const mic = document.getElementById("mic") as HTMLElement;
    const clicked = vi.fn();
    mic.addEventListener("click", clicked);

    // Enter clears the composer, standing in for the host sending the message.
    composer.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") composer.textContent = "";
    });

    const outcome = await insertAndSubmit(adapterFor(() => composer, () => mic), "hello");

    expect(clicked).not.toHaveBeenCalled();
    expect(outcome.status).toBe("sent");
    expect(outcome.detail).toBe("pressed Enter");
  });

  it("reports why it refused when Enter does not submit either", async () => {
    document.body.innerHTML = `
      <div id="composer" contenteditable="true"></div>
      <button id="mic" aria-label="Voice mode"></button>`;
    const composer = document.getElementById("composer") as HTMLElement;
    const mic = document.getElementById("mic") as HTMLElement;

    const outcome = await insertAndSubmit(adapterFor(() => composer, () => mic), "hello");

    expect(outcome.status).toBe("no_submit");
    expect(outcome.detail).toMatch(/refused to click/);
    expect(outcome.detail).toMatch(/Voice mode/);
  });

  it("clicks a genuine send button", async () => {
    document.body.innerHTML = `
      <div id="composer" contenteditable="true"></div>
      <button id="send" aria-label="Send message"></button>`;
    const composer = document.getElementById("composer") as HTMLElement;
    const send = document.getElementById("send") as HTMLElement;
    send.addEventListener("click", () => {
      composer.textContent = "";
    });

    const outcome = await insertAndSubmit(adapterFor(() => composer, () => send), "hello");
    expect(outcome.status).toBe("sent");
    expect(outcome.detail).toBe("clicked send");
  });

  it("does not clobber text the user is part-way through writing", async () => {
    document.body.innerHTML = `<div id="composer" contenteditable="true">half a thought</div>`;
    const composer = document.getElementById("composer") as HTMLElement;
    const outcome = await insertAndSubmit(adapterFor(() => composer, () => null), "hello");

    expect(outcome.status).toBe("busy");
    expect(composer.textContent).toBe("half a thought");
  });

  it("waits rather than interrupting a response in flight", async () => {
    document.body.innerHTML = `<div id="composer" contenteditable="true"></div>`;
    const composer = document.getElementById("composer") as HTMLElement;
    const adapter = { ...adapterFor(() => composer, () => null), isStreaming: () => true };
    expect((await insertAndSubmit(adapter, "hello")).status).toBe("streaming");
  });

  it("says so when there is no composer at all", async () => {
    const outcome = await insertAndSubmit(adapterFor(() => null, () => null), "hello");
    expect(outcome.status).toBe("no_composer");
  });

  it("treats a placeholder rendered as text as an empty composer", async () => {
    document.body.innerHTML = `<div id="composer" contenteditable="true" data-placeholder="Ask Gemini">Ask Gemini</div>`;
    const composer = document.getElementById("composer") as HTMLElement;
    composer.addEventListener("keydown", () => {
      composer.textContent = "";
    });
    const outcome = await insertAndSubmit(adapterFor(() => composer, () => null), "hello");
    expect(outcome.status).toBe("sent");
  });

  it("falls back to a paste event when execCommand is unavailable", async () => {
    // jsdom ships neither of these; a browser has both. Polyfilled here because
    // the subject under test is our fallback path, not jsdom's API coverage.
    class FakeDataTransfer {
      private readonly store = new Map<string, string>();
      setData(type: string, value: string): void {
        this.store.set(type, value);
      }
      getData(type: string): string {
        return this.store.get(type) ?? "";
      }
    }
    vi.stubGlobal("DataTransfer", FakeDataTransfer);
    vi.stubGlobal(
      "ClipboardEvent",
      class extends Event {
        clipboardData: FakeDataTransfer | undefined;
        constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer } = {}) {
          super(type, init);
          this.clipboardData = init.clipboardData;
        }
      },
    );

    (document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error("execCommand has been removed");
    };
    document.body.innerHTML = `<div id="composer" contenteditable="true"></div>`;
    const composer = document.getElementById("composer") as HTMLElement;
    let pasted = "";
    composer.addEventListener("paste", (event) => {
      pasted = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
      composer.textContent = pasted;
    });
    composer.addEventListener("keydown", () => {
      composer.textContent = "";
    });

    const outcome = await insertAndSubmit(adapterFor(() => composer, () => null), "hello world");
    expect(pasted).toBe("hello world");
    expect(outcome.status).toBe("sent");
    vi.unstubAllGlobals();
  });

  it("reports insert_failed rather than throwing when no insertion path works", async () => {
    (document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error("execCommand has been removed");
    };
    document.body.innerHTML = `<div id="composer" contenteditable="true"></div>`;
    const composer = document.getElementById("composer") as HTMLElement;

    // No DataTransfer in this environment either, so the paste path cannot run.
    const outcome = await insertAndSubmit(adapterFor(() => composer, () => null), "hello");
    expect(outcome.status).toBe("insert_failed");
    expect(outcome.detail).toMatch(/could not type/);
  });
});

describe("an orphaned content script", () => {
  it("does not leak Chrome's raw wording into the conversation", async () => {
    // Observed live on perplexity.ai: reloading the extension while a chat page
    // was open produced a tool result reading `status: error / Extension
    // context invalidated.` — Chrome's internal wording, pasted into the chat.
    // It tells the model nothing and the user less.
    const { ORPHANED_TEXT } = await import("./helpers/orphan.js");
    expect(ORPHANED_TEXT).toMatch(/extension was reloaded/i);
    expect(ORPHANED_TEXT).toMatch(/reload this page/i);
    expect(ORPHANED_TEXT).not.toMatch(/context invalidated/i);
  });
});

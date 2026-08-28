import { isPlausibleSubmit, submitRejectionReason } from "./adapters/heuristics.js";
import type { SiteAdapter } from "./adapters/index.js";

/**
 * Typing into somebody else's editor.
 *
 * All three hosts use a rich-text editor (ProseMirror or Lexical) or a
 * controlled textarea, and none of them notice a direct `textContent =` or a
 * plain `value =`. `insertText` via `execCommand` is the one path that produces
 * the same events a real keystroke would, so the editor's own state stays in
 * sync. It is deprecated and works everywhere; the alternative is a per-host
 * reimplementation of each editor's internals.
 */
export type SubmitStatus = "sent" | "busy" | "streaming" | "no_composer" | "insert_failed" | "no_submit";

export interface SubmitOutcome {
  status: SubmitStatus;
  /** Human-readable reason, surfaced in the popup when something went wrong. */
  detail: string;
}

export async function insertAndSubmit(
  adapter: SiteAdapter,
  text: string,
): Promise<SubmitOutcome> {
  const composer = adapter.composer();
  if (!composer) {
    return { status: "no_composer", detail: "could not find the message composer on this page" };
  }

  if (adapter.isStreaming()) {
    return { status: "streaming", detail: "the assistant is still generating" };
  }
  // Never clobber something the user is halfway through writing.
  const existing = currentText(composer);
  if (existing.trim() !== "") {
    return { status: "busy", detail: `the composer already contains ${existing.length} characters` };
  }

  composer.focus();
  if (!setText(composer, text)) {
    return {
      status: "insert_failed",
      detail: `could not type into <${composer.tagName.toLowerCase()}>`,
    };
  }

  // Let the editor's own state settle before asking it to submit.
  await frame();
  await frame();

  const button = adapter.submitButton();
  let refused: string | null = null;

  if (button && !isPlausibleSubmit(button)) {
    // The adapter handed back something that looks like a microphone, a Copy
    // button or an upload control. Clicking it would do real damage — recording
    // the user, or silently dropping the tool result — so it is not clicked at
    // all, and Enter is used instead.
    refused = submitRejectionReason(button);
    console.warn(`[webmcp] ${refused}`);
  } else if (button && !isDisabled(button)) {
    button.click();
    // Trust nothing: a click on the wrong element looks exactly like a click on
    // the right one. An emptied composer is the only real evidence it sent.
    if (await composerCleared(composer)) return { status: "sent", detail: "clicked send" };
  }

  // Either there was no usable button, or clicking it did nothing. Enter is
  // what every one of these composers treats as send.
  pressEnter(composer);
  if (await composerCleared(composer)) return { status: "sent", detail: "pressed Enter" };

  return {
    status: "no_submit",
    detail:
      refused ??
      (button
        ? "typed the message, but neither the send button nor Enter submitted it"
        : "typed the message, but could not find a send button and Enter did not submit it"),
  };
}

/** Poll briefly: submission is asynchronous in all three editors. */
async function composerCleared(composer: HTMLElement, attempts = 12): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await sleep(60);
    if (currentText(composer).trim() === "") return true;
  }
  return false;
}

function currentText(el: HTMLElement): string {
  if (isTextField(el)) return el.value;
  const text = (el.textContent ?? "").replace(/[​‌‍﻿]/g, "");
  // Some editors render the placeholder as a real text node rather than via
  // CSS, which would otherwise read as "the user is typing".
  const placeholder = el.getAttribute("data-placeholder") ?? el.getAttribute("aria-placeholder");
  if (placeholder && text.trim() === placeholder.trim()) return "";
  return text;
}

function setText(el: HTMLElement, text: string): boolean {
  if (isTextField(el)) {
    // React and friends install a value setter on the prototype and watch it;
    // assigning the own property would update the DOM and not the framework.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value === text;
  }

  if (isEditable(el)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // Multi-line insertText keeps the newlines the fenced block needs.
    // Wrapped because `execCommand` is deprecated: an engine that has dropped
    // it should fall through to the paste path, not throw out of here and take
    // the whole delivery with it.
    try {
      if (document.execCommand("insertText", false, text)) return true;
    } catch {
      /* fall through to the paste fallback */
    }

    // Last resort for editors that intercept execCommand: a paste event with a
    // synthetic clipboard, which ProseMirror and Lexical both handle.
    //
    // Guarded because this is already the fallback path — if `DataTransfer` or
    // `ClipboardEvent` is unavailable, the honest outcome is "could not type",
    // reported to the user. Throwing from here would take down the delivery and
    // surface as nothing happening at all.
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    } catch {
      return false;
    }
    return (el.textContent ?? "").includes(text.slice(0, 16));
  }

  return false;
}

function pressEnter(el: HTMLElement): void {
  const init = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  } as KeyboardEventInit;
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

function isTextField(el: HTMLElement): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

/**
 * Editable by either measure.
 *
 * `isContentEditable` is the computed, inherited value and `contenteditable` is
 * the explicit attribute, and they genuinely disagree in both directions: a
 * child of an editable region is editable with no attribute of its own, and an
 * engine that does not implement the property reports nothing for an element
 * that plainly has the attribute. Requiring only the property meant refusing to
 * type into composers that were obviously editable.
 */
function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable === true) return true;
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    el.getAttribute("disabled") !== null
  );
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

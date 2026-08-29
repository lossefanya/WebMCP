import type { SiteAdapter } from "./adapters/index.js";
import { acceptsFile, isPlausibleSubmit, submitRejectionReason } from "./adapters/heuristics.js";
import {
  type PendingAttachment,
  attachFile,
  chipScope,
  dismissUploader,
  revealFileInput,
} from "./attach.js";

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
export type SubmitStatus =
  | "sent"
  | "busy"
  | "streaming"
  | "no_composer"
  | "insert_failed"
  | "no_submit"
  /** The file never went up. The caller has a fallback: paste a shortened result. */
  | "attach_failed";

export interface SubmitOutcome {
  status: SubmitStatus;
  /** Human-readable reason, surfaced in the popup when something went wrong. */
  detail: string;
}

/**
 * Type `text` into the composer and send it, optionally with a file attached
 * first.
 *
 * The attachment goes up *before* anything is typed, so a failed upload leaves
 * the composer untouched and the caller can fall back to pasting a shortened
 * result without first having to clear a half-written turn.
 */
export async function insertAndSubmit(
  adapter: SiteAdapter,
  message: string,
  attachment?: PendingAttachment,
): Promise<SubmitOutcome> {
  let text = message;
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

  if (attachment) {
    const attached = await attach(adapter, composer, attachment);
    if ("status" in attached) return attached;
    // The covering message names the file, and the name may have changed on the
    // way in — a host whose `accept` list does not know `.zig` gets `.zig.md`.
    // Substituting here keeps the message honest about what actually went up.
    text = text.split(attachment.filename).join(attached.filename);
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

/**
 * Get the file into the composer, opening the host's uploader first if that is
 * the only way to reach one. Returns the failure, or null on success.
 */
async function attach(
  adapter: SiteAdapter,
  composer: HTMLElement,
  attachment: PendingAttachment,
): Promise<SubmitOutcome | { filename: string }> {
  const fail = (detail: string): SubmitOutcome => ({ status: "attach_failed", detail });

  let input = adapter.fileInput?.() ?? null;
  // Only clicked when the input is genuinely absent. On the hosts that keep one
  // in the composer at all times there is no reason to open anything, and not
  // clicking is always the safer of the two.
  const trigger = input ? null : (adapter.uploadTrigger?.() ?? null);
  if (!input && trigger) {
    input = await revealFileInput(trigger, () => adapter.fileInput?.() ?? null);
  }
  if (!input) {
    return fail("this page has no file input to upload to");
  }

  // The daemon names the attachment after the file that was read, so the model
  // and the user can see which one it is. Most of those names go up untouched —
  // both hosts with an `accept` list take `.csv`, `.json`, `.ts` and so on — but
  // the lists are finite (neither takes `.zig` or `.log`), and a name the host
  // refuses would mean falling back to a truncated paste for no good reason.
  // Appending `.md` is the escape hatch, not the default it used to be.
  const usable = acceptsFile(input, attachment.filename, attachment.mediaType)
    ? attachment
    : { ...attachment, filename: `${attachment.filename}.md`, mediaType: "text/markdown" };

  if (!acceptsFile(input, usable.filename, usable.mediaType)) {
    return fail(`this page's uploader refuses ${attachment.filename}`);
  }

  // Scoped to the composer, not the input: a revealed input sits in an overlay
  // that is torn down when the menu closes, and the chip appears by the
  // composer either way.
  const outcome = await attachFile(input, usable, { scope: chipScope(composer) });
  if (trigger) dismissUploader(trigger);

  return outcome === "attached"
    ? { filename: usable.filename }
    : fail(`could not attach ${usable.filename}: ${outcome}`);
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

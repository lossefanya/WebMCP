import { acceptsFile, isPlausibleUploadTrigger } from "./adapters/heuristics.js";

/**
 * Handing a file to somebody else's uploader.
 *
 * This exists because a large result cannot be typed. Every composer on these
 * hosts is a rich-text editor that builds a node per line, so a 200KB file
 * pasted in is one enormous synchronous reconciliation and the tab stops
 * responding — which is the bug this path was added to fix, not an
 * optimisation.
 *
 * The mechanics are the ones a real drop performs: build a `File`, put it in a
 * `DataTransfer`, assign the list to the input and fire `change`. React and
 * friends do not check `isTrusted`, so the site takes it exactly as it would a
 * file the user picked. Nothing here is site-specific except the input itself,
 * which comes from the adapter.
 */
export interface PendingAttachment {
  filename: string;
  /** Short unique token inside `filename`; what confirmation looks for. */
  marker: string;
  mediaType: string;
  body: string;
}

export type AttachStatus =
  /** The host has accepted the file and is showing it. */
  | "attached"
  /** This input would refuse the file — usually an `accept` list for images. */
  | "rejected"
  /** The APIs needed to synthesise a file are missing. */
  | "unsupported"
  /** Handed over, but the host never showed it. Treated as a failure. */
  | "unconfirmed";

/**
 * How long to wait for the host to show the attachment before giving up.
 *
 * Generous, because this covers a real upload over the network. Overridable so
 * the tests can exercise the give-up path without spending ten seconds on it.
 */
export interface ConfirmTiming {
  timeoutMs?: number;
  pollMs?: number;
}

const CONFIRM_TIMEOUT_MS = 10_000;
const CONFIRM_POLL_MS = 250;
/** How far up from an element to look for the host's "file attached" chip. */
const CHIP_SCOPE_DEPTH = 8;
/** How long to wait for a revealed uploader to appear in the DOM. */
const REVEAL_TIMEOUT_MS = 2_000;
const REVEAL_POLL_MS = 50;

/**
 * Open a host's uploader menu and hand back the input it creates.
 *
 * Gemini builds its `<uploader>` inside a CDK overlay on demand, so there is
 * nothing to attach to until this runs. The click is the riskiest thing the
 * extension does unprompted, so it happens only when a result genuinely needs
 * uploading, only against a positively-labelled trigger, and — through
 * `dismiss` below — is undone afterwards.
 */
export async function revealFileInput(
  trigger: HTMLElement,
  find: () => HTMLInputElement | null,
  timing: ConfirmTiming = {},
): Promise<HTMLInputElement | null> {
  if (!isPlausibleUploadTrigger(trigger)) {
    console.warn(
      `[webmcp] refused to click <${trigger.tagName.toLowerCase()}> to open the uploader — ` +
        "its label does not look like uploading",
    );
    return null;
  }

  trigger.click();

  const poll = timing.pollMs ?? REVEAL_POLL_MS;
  const deadline = Date.now() + (timing.timeoutMs ?? REVEAL_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(poll);
    const input = find();
    if (input) return input;
  }

  // The menu may well have opened even though no input turned up in it. Leaving
  // it hanging over the composer would be a visible mess the user did not ask
  // for, and the caller is about to paste instead.
  dismissUploader(trigger);
  return null;
}

/**
 * Put the uploader menu back.
 *
 * Toggled by clicking the trigger again rather than by pressing Escape, and
 * only when `aria-expanded` says it is still open: a stray Escape in a chat UI
 * can clear a draft or close something else entirely, and clicking a trigger
 * that has already closed itself would just reopen it.
 */
export function dismissUploader(trigger: HTMLElement): void {
  if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
}

export async function attachFile(
  input: HTMLInputElement,
  attachment: PendingAttachment,
  timing: ConfirmTiming & { scope?: Element } = {},
): Promise<AttachStatus> {
  // Re-checked here rather than only where the input was found. The adapter's
  // own selector list ends in a bare `input[type="file"]`, so a host that moves
  // its uploader can hand back an avatar picker — the same lesson as
  // `isPlausibleSubmit`, which had to move to the point of clicking for exactly
  // this reason.
  if (input.disabled || !acceptsFile(input, attachment.filename, attachment.mediaType)) {
    return "rejected";
  }

  let list: FileList;
  try {
    const file = new File([attachment.body], attachment.filename, {
      type: attachment.mediaType,
      // A file with no date is fine; one with an unreadable date is not, and
      // engines differ on the default.
      lastModified: Date.now(),
    });
    const data = new DataTransfer();
    data.items.add(file);
    list = data.files;
  } catch {
    // `DataTransfer` is not universal. Degrading to a shortened paste is the
    // honest outcome; throwing from here would surface as nothing happening.
    return "unsupported";
  }

  try {
    input.files = list;
  } catch {
    return "unsupported";
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  if (await appears(timing.scope ?? chipScope(input), attachment.marker, timing)) {
    return "attached";
  }

  // Nothing visible came back, so the upload is in an unknown state. Clear the
  // input before falling back: sending the covering note *and* having the file
  // land a moment later would put the same result in the conversation twice,
  // and an unexplained attachment is worse than a shortened paste.
  clear(input);
  return "unconfirmed";
}

/**
 * Wait for the host to show the file.
 *
 * Matched on the daemon's short `marker` rather than on the filename, and both
 * halves of that matter. The chip routinely mangles the name — Perplexity's
 * document card drops the extension entirely — and the filename now carries the
 * *source* name, which the conversation is very likely to contain already,
 * because the user just asked for that file by name. Matching it would confirm
 * an upload that never happened.
 *
 * Confirmation is required, not assumed. Uploading is a network round trip that
 * can be rejected for size, for type, or for being logged out, and submitting a
 * turn whose only content is "the output is attached" with no attachment is a
 * worse failure than truncating: the model answers from a note about a file
 * that is not there.
 */
async function appears(
  scope: Element,
  marker: string,
  timing: ConfirmTiming,
): Promise<boolean> {
  const poll = timing.pollMs ?? CONFIRM_POLL_MS;
  const deadline = Date.now() + (timing.timeoutMs ?? CONFIRM_TIMEOUT_MS);

  while (Date.now() < deadline) {
    await sleep(poll);
    if ((scope.textContent ?? "").includes(marker)) return true;
  }
  return false;
}

/**
 * Where the host draws its attachment chip: a bounded walk up, not the whole
 * document. The chip is rendered in the composer's own area, and scanning
 * `document.body.textContent` on a long conversation is a large string copy
 * every poll.
 *
 * Walked from the *composer* rather than the input wherever the caller can
 * supply one. On Gemini the input lives in an overlay that is detached again
 * the moment the menu closes, so a scope derived from it would be an orphaned
 * subtree that no chip could ever appear in.
 */
export function chipScope(from: Element): Element {
  let scope: Element = from;
  for (let depth = 0; depth < CHIP_SCOPE_DEPTH; depth++) {
    const parent = scope.parentElement;
    if (!parent) break;
    scope = parent;
    if (scope === document.body) break;
  }
  return scope;
}

function clear(input: HTMLInputElement): void {
  try {
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch {
    /* nothing better to do; the caller is already falling back */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import type { SiteAdapter } from "./types.js";

/**
 * Site-agnostic fallbacks for when a host reships its DOM and the named
 * selectors stop matching.
 *
 * These are guesses, and they are deliberately last in line — a named selector
 * is always right when it hits, and a guess is only better than failing dead.
 * The point is that a selector going stale degrades to "probably still works,
 * and the popup can tell you it fell back" rather than to silence.
 */

/**
 * Markers that identify a *user* turn on the supported hosts.
 *
 * These exist because of a hazard that is easy to miss: the injected preamble
 * contains a worked example of a tool call, and every tool result is pasted
 * back as a user turn. Both render as real code blocks inside the user's own
 * messages. A scanner that reads a user turn will therefore find a
 * syntactically perfect `fs_read` call sitting in the instructions and run it —
 * a tool call the model never made.
 */
const USER_TURN_MARKERS = [
  '[data-message-author-role="user"]',
  '[data-testid="user-message"]',
  '[data-perf-row="human"]',
  'article[data-turn="user"]',
  // Gemini. Its user turns are the worse case: the preamble is rendered as
  // plain-text paragraphs with the literal ``` fences left intact, so the text
  // scanner finds a complete, closed, perfectly valid tool call in them.
  "user-query",
  "user-query-content",
  // Perplexity. It offers no data attribute on the bubble itself, so this keys
  // on the Tailwind group name and on the per-query action buttons — the user
  // text there is a `whitespace-pre-line` span holding the raw markdown,
  // fences included.
  '[class*="user-bubble"]',
  '[data-testid="toggle-query-expand-button"]',
  ':has(> button[aria-label="Edit query"])',
];

/**
 * True if this element is a user turn, sits inside one, or contains one.
 *
 * "Contains one" matters for the wide fallbacks: an element that wraps both
 * sides of the conversation cannot be scanned safely, so it is rejected rather
 * than trusted.
 */
/**
 * How far back a scan looks before doing any per-turn DOM work, and how many
 * turns it ultimately reads.
 *
 * `touchesUserTurn` costs a full subtree `querySelector` per marker per turn,
 * and a scan runs on every mutation and every poll. Filtering the whole
 * conversation and *then* taking the tail made that cost grow with the length
 * of the chat: each pasted result added a turn, every later scan walked all of
 * them, and a session that read many files eventually stopped keeping up.
 *
 * The window is larger than the depth on purpose. Filtering is a safety net for
 * a selector that over-matches, so it needs a few turns of slack — but bounded,
 * because only the tail can hold a call that has not been handled yet.
 */
export const SCAN_WINDOW = 8;
export const SCAN_DEPTH = 2;

/**
 * The turns a scan should actually read. Pure, so the cost is testable: the
 * work here must not grow with the size of the conversation.
 */
export function turnsToScan(
  turns: Element[],
  depth: number = SCAN_DEPTH,
  window: number = SCAN_WINDOW,
): Element[] {
  const recent = window > 0 ? turns.slice(-window) : turns;
  const valid = recent.filter((turn) => !touchesUserTurn(turn));
  return depth > 0 ? valid.slice(-depth) : valid;
}

export function touchesUserTurn(el: Element): boolean {
  for (const selector of USER_TURN_MARKERS) {
    try {
      if (el.matches(selector)) return true;
      if (el.closest(selector) !== null) return true;
      if (el.querySelector(selector) !== null) return true;
    } catch {
      /* unusable selector; skip it */
    }
  }
  return false;
}

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/**
 * The composer, by shape: the biggest visible text-entry box in the lower part
 * of the viewport. Every one of these chat UIs puts it there, and none of them
 * has a second large editable box competing with it.
 */
export function guessComposer(): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea')];
  const scored = candidates
    .filter(isVisible)
    // Quill keeps a hidden second contenteditable for clipboard handling, and
    // an explicit tabindex="-1" means the page took it out of the tab order —
    // not somewhere a user types.
    //
    // Tested against the *attribute*, not the `tabIndex` property: the property's
    // default for a `contenteditable` div is not consistently specified, so
    // reading it would reject legitimate composers on whichever engine reports
    // -1 there.
    .filter((el) => !el.classList.contains("ql-clipboard") && el.getAttribute("tabindex") !== "-1")
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const verticalBias = rect.top / Math.max(1, window.innerHeight);
      return { el, score: rect.width * rect.height * (0.25 + verticalBias) };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.el ?? null;
}

/**
 * Labels that mean "definitely not the send button". A wrong click here is not
 * a near miss — clicking a microphone starts recording the user, and clicking a
 * code block's Copy button silently swallows the tool result.
 */
const NOT_SUBMIT =
  /mic|dictat|record|voice|audio|speech|upload|attach|download|file|image|photo|camera|menu|model|picker|copy|stop|cancel|close|settings|share|thumb|like|dislike|helpful|feedback|report|fork|share|upgrade|edit|delete|remove|regenerat|redo|retry|scroll|expand|collapse|search|source|focus|new thread|sign in/i;

/**
 * Whether it is safe to click this element as the send button.
 *
 * Checked at the point of clicking, not only where a button is *found*. The
 * deny-list originally lived in the heuristic alone, which missed the case that
 * actually bit a user: a hand-written adapter selector — `button[aria-label*=
 * "Submit" i]` and friends — matching the microphone on a site whose real send
 * button was not present or not labelled as expected. A guard that only covers
 * the guessing path does not cover the path where someone guessed in advance
 * and wrote it down.
 *
 * An unlabelled button is allowed: plenty of icon-only send buttons carry no
 * accessible name at all, so only a positively wrong label is disqualifying.
 */
export function isPlausibleSubmit(el: Element): boolean {
  // Structural checks first, because they are the ones a word list can never
  // get right. A send button is not a toggle and does not open a menu, so ARIA
  // saying otherwise settles it without knowing what the button is called.
  // This is what catches Perplexity's Search/Computer mode toggles, which carry
  // no aria-label at all — only `aria-pressed` and some visible text.
  //
  // Checked on the element *and its nearest ancestors*: Gemini wraps its
  // buttons in custom elements (`<gem-icon-button aria-haspopup="true">
  // <button>`) and puts the ARIA on the wrapper, so looking only at the
  // `<button>` misses it. Bounded to two levels — a distant ancestor being
  // expanded says nothing about the button inside it.
  let node: Element | null = el;
  for (let depth = 0; depth <= 2 && node; depth++) {
    if (node.hasAttribute("aria-pressed")) return false;
    if (node.hasAttribute("aria-haspopup")) return false;
    const expanded = node.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") return false;
    node = node.parentElement;
  }

  return !NOT_SUBMIT.test(labelOf(el));
}

/** Why a button was rejected, for the failure report. */
export function submitRejectionReason(el: Element): string {
  const scope = el.closest("[aria-pressed],[aria-haspopup],[aria-expanded]");
  const why = scope?.hasAttribute("aria-pressed")
    ? "it is a toggle"
    : scope?.hasAttribute("aria-haspopup")
      ? "it opens a menu"
      : scope?.hasAttribute("aria-expanded")
        ? "it expands something"
        : "its label does not look like sending";
  return `refused to click <${el.tagName.toLowerCase()}> labelled ${JSON.stringify(
    labelOf(el).slice(0, 60),
  )} — ${why}`;
}

/**
 * The send button, by proximity: a visible button inside the composer's own
 * container whose label actually looks like sending.
 *
 * Deliberately gives up rather than guessing. This used to fall back to "the
 * last visible button", which on Gemini's zero state is the microphone — the
 * send button does not exist until the composer has text. Returning null is
 * safe: the caller falls back to pressing Enter, which every one of these
 * composers treats as send.
 */
export function guessSubmitButton(composer: HTMLElement | null): HTMLElement | null {
  const start = composer?.closest("form") ?? composer ?? document.body;

  // Widen one ancestor at a time and take the nearest match.
  //
  // A fixed walk up N parents does not work: on Gemini the composer sits inside
  // three wrapper divs and the send button is a cousin well outside that
  // subtree, while on a host that does use a `<form>` the button is right
  // there. Growing the scope until a send-ish button appears handles both, and
  // "nearest wins" keeps it from reaching some unrelated Send elsewhere on the
  // page.
  let scope: HTMLElement | null = start;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK && scope; depth++) {
    const found = findSendish(scope);
    if (found) return found;
    if (scope === document.body) break;
    scope = scope.parentElement;
  }
  return null;
}

const MAX_ANCESTOR_WALK = 10;

function findSendish(scope: HTMLElement): HTMLElement | null {
  const sendish = [...scope.querySelectorAll<HTMLElement>("button")]
    .filter(isVisible)
    .filter((el) => {
      const label = labelOf(el);
      return /send|submit/i.test(label) && !NOT_SUBMIT.test(label);
    });

  // Last one wins within a scope: when a UI offers both "Send" and something
  // like "Send later", the primary action sits nearest the trailing edge.
  return sendish[sendish.length - 1] ?? null;
}

function labelOf(el: Element): string {
  return [
    el.getAttribute("aria-label"),
    el.getAttribute("data-testid"),
    el.getAttribute("data-test-id"),
    el.getAttribute("title"),
    el.getAttribute("name"),
    el.getAttribute("type"),
    // Icon fonts put the glyph name in an attribute, which is often the only
    // hint an icon-only button gives about what it does.
    el.querySelector("[data-mat-icon-name]")?.getAttribute("data-mat-icon-name"),
    el.querySelector("[fonticon]")?.getAttribute("fonticon"),
    // An SVG sprite reference is often the only clue on an icon-only button —
    // Perplexity's mic is `#pplx-icon-microphone` and nothing else.
    el.querySelector("use")?.getAttribute("xlink:href") ??
      el.querySelector("use")?.getAttribute("href"),
    // The button's own visible text, when it is short enough to be a label
    // rather than a panel that happens to contain a button.
    shortText(el),
  ]
    .filter(Boolean)
    .join(" ");
}

function shortText(el: Element): string | null {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= 30 ? text : null;
}

/**
 * Whether this input would accept a file with the given name and type.
 *
 * `accept` is a real filter, not decoration: a profile-picture input says
 * `image/*` and would silently reject a markdown file, and refusing it here is
 * the difference between falling back to a paste and sending a message with a
 * missing attachment. An input with no `accept` takes anything.
 */
export function acceptsFile(
  input: HTMLInputElement,
  filename: string,
  mediaType: string,
): boolean {
  const accept = input.getAttribute("accept")?.trim();
  if (!accept) return true;

  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const [group] = mediaType.split("/");
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (rule === "" || rule === "*/*") return true;
    if (rule.startsWith(".")) return rule === extension;
    if (rule.endsWith("/*")) return rule.slice(0, -2) === group;
    return rule === mediaType.toLowerCase();
  });
}

/**
 * Whether it is safe to click this element to open the uploader.
 *
 * The mirror of `isPlausibleSubmit`, and needed for the same reason: this is
 * the second element on the page the extension clicks on its own initiative,
 * and the failure modes are the ones this project has already been bitten by
 * once. Sending the turn early is the worst of them — the covering note would
 * go out before the file — so anything that reads as send, or as the composer's
 * microphone, is refused outright.
 *
 * Unlike the submit check, an *unlabelled* element is refused too. There is no
 * such thing as a send-by-Enter fallback here: if the label does not positively
 * say "upload", not clicking costs a shortened paste, and clicking the wrong
 * thing costs the user something real.
 */
const UPLOAD_TRIGGER = /upload|attach|paperclip|add file|add photo|add image/i;
const NOT_UPLOAD_TRIGGER = /send|submit|dictat|mic|voice|record|stop|delete|remove|download/i;

export function isPlausibleUploadTrigger(el: Element): boolean {
  const label = labelOf(el);
  return UPLOAD_TRIGGER.test(label) && !NOT_UPLOAD_TRIGGER.test(label);
}

/**
 * A file input near the composer, for hosts whose own selector is missing or
 * has gone stale.
 *
 * Scoped by widening from the composer, exactly like `guessSubmitButton`, and
 * for the same reason: on one host the input is a sibling of the composer and
 * on another it is several levels up. Deliberately *not* filtered by
 * visibility — every one of these is `display: none` and clicked through a
 * label — so `accept` is doing the work of ruling out the wrong input, which is
 * mostly an avatar uploader saying `image/*`.
 *
 * Returning null is safe: the caller pastes a shortened result instead.
 */
export function guessFileInput(
  composer: HTMLElement | null,
  filename: string,
  mediaType: string,
): HTMLInputElement | null {
  const start = composer?.closest("form") ?? composer ?? document.body;

  let scope: HTMLElement | null = start;
  for (let depth = 0; depth < MAX_ANCESTOR_WALK && scope; depth++) {
    const found = [...scope.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
      (input) => !input.disabled && acceptsFile(input, filename, mediaType),
    );
    if (found) return found;
    if (scope === document.body) break;
    scope = scope.parentElement;
  }
  return null;
}

/**
 * Wrap an adapter so every lookup falls back to a heuristic, and record which
 * lookups needed one. `fellBackOn` is what the popup shows — a working page
 * that is limping tells you the adapter needs updating before it breaks
 * outright.
 */
export interface WrappedAdapter extends SiteAdapter {
  readonly fellBackOn: Set<string>;
  /** Always present after wrapping, unlike the adapter's own optional hooks. */
  fileInput(): HTMLInputElement | null;
  uploadTrigger(): HTMLElement | null;
}

export function withFallbacks(adapter: SiteAdapter): WrappedAdapter {
  const fellBackOn = new Set<string>();

  const note = <T>(name: string, primary: T | null, fallback: () => T | null): T | null => {
    if (primary) return primary;
    const guess = fallback();
    if (guess) fellBackOn.add(name);
    return guess;
  };

  return {
    id: adapter.id,
    fellBackOn,

    conversationRoot: () =>
      note("conversationRoot", adapter.conversationRoot(), () => document.querySelector("main") ?? document.body),

    assistantTurns: () => {
      const named = adapter.assistantTurns().filter((el) => !touchesUserTurn(el));
      if (named.length) return named;

      // Nothing matched. Fall back to containers that hold rendered markdown —
      // but never to `document.body`, and never to anything touching a user
      // turn.
      //
      // This used to widen all the way to the whole document on the reasoning
      // that a superset is harmless because de-duplication prevents repeats.
      // That was wrong: the preamble's worked example is a valid tool call
      // living in a *user* message, so a superset scan runs a call the model
      // never made. Firing once is enough to be wrong. Returning nothing is
      // visible in the diagnostics and safe; guessing wide is neither.
      fellBackOn.add("assistantTurns");
      return [...document.querySelectorAll("main .markdown, main article, [data-message-id]")].filter(
        (el) => !touchesUserTurn(el),
      );
    },

    isStreaming: () => adapter.isStreaming(),

    composer: () => note("composer", adapter.composer(), guessComposer),

    submitButton: () => {
      const named = adapter.submitButton();
      if (named) return named;
      const guess = guessSubmitButton(adapter.composer() ?? guessComposer());
      if (guess) fellBackOn.add("submitButton");
      return guess;
    },

    // A host with no `fileInput` of its own is not a broken adapter — two of
    // the four have no captured upload control — so this guesses without
    // complaint, and null simply means big results keep being pasted.
    // Deliberately not guessed. Finding an input is harmless, but *clicking*
    // something to reveal one is not, so this is named-selector-only: a host
    // whose trigger moves stops uploading rather than starts clicking around.
    uploadTrigger: () => adapter.uploadTrigger?.() ?? null,

    fileInput: () => {
      const named = adapter.fileInput?.() ?? null;
      if (named) return named;
      const guess = guessFileInput(
        adapter.composer() ?? guessComposer(),
        PROBE_FILENAME,
        PROBE_MEDIA_TYPE,
      );
      if (guess) fellBackOn.add("fileInput");
      return guess;
    },
  };
}

/**
 * What the guess measures an `accept` list against. The real filename is not
 * known until a result arrives, but every one of them is a `.md` document, so
 * an input that would refuse this would refuse all of them.
 */
const PROBE_FILENAME = "webmcp-result.md";
const PROBE_MEDIA_TYPE = "text/markdown";

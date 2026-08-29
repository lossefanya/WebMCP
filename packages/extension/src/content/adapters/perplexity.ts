import { type SiteAdapter, allMatches, firstMatch } from "./types.js";

/**
 * perplexity.ai.
 *
 * The composer is Lexical, marked by `data-lexical-editor="true"` and given the
 * stable id `ask-input` — both confirmed against a live page.
 *
 * This is the adapter where a wrong click actually happened, and the reason is
 * worth keeping written down: Perplexity renders **no submit button at all**
 * until the composer has text. In the zero state the buttons nearest the
 * composer are "Add files or tools", the Search/Computer mode toggles, "Model",
 * "Dictation" and — last, and styled as the prominent accent button — "Use
 * voice mode". Any fallback that reaches for "the last button near the
 * composer" lands on voice mode.
 */
export const perplexityAdapter: SiteAdapter = {
  id: "perplexity",

  conversationRoot: () =>
    firstMatch([
      "div.scrollable-container",
      "main",
      "#__next main",
      "body",
    ]),

  /**
   * `[data-workflow-final-text]` is the answer container — confirmed against a
   * live thread, and it holds only the assistant's rendered markdown (the
   * Copy/Share/thumbs row is a *sibling*, `[data-workflow-text-footer]`).
   *
   * Note what is not used: `.prose` alone would still work here, but the user
   * bubble is a plain `whitespace-pre-line` span rather than a `.prose` block,
   * so the two never overlap. That is luck, not design — `touchesUserTurn`
   * carries the actual guarantee.
   */
  assistantTurns: () =>
    allMatches([
      "[data-workflow-final-text]",
      '.prose[data-renderer="lm"]',
      '[data-testid="answer"]',
      "div.prose",
    ]),

  // Unverified: the captured thread was idle. A false "streaming" only lengthens
  // the settling window, so this failing open is cheap.
  isStreaming: () =>
    firstMatch([
      '[data-testid="stop-generating"]',
      'button[aria-label="Stop"]',
      'button[aria-label*="Stop generating" i]',
    ]) !== null,

  // `#ask-input` first — it is the most specific thing on the page, and the
  // Lexical marker is the next most durable.
  composer: () =>
    firstMatch<HTMLElement>([
      "#ask-input",
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"]',
    ]),

  /**
   * `button[aria-label="Submit"]` — confirmed. Like claude.ai, it exists but is
   * `disabled` and `pointer-events-none` while the composer is empty; in the
   * zero state it is absent entirely and "Use voice mode" occupies that slot,
   * which is how the mic got clicked.
   *
   * Exact matches only. `button[aria-label*="Submit" i]` used to lead this list,
   * and a substring match across a whole page is how the wrong button gets
   * picked; `isPlausibleSubmit` in `compose.ts` is the backstop.
   */
  submitButton: () =>
    firstMatch<HTMLElement>([
      'button[aria-label="Submit"]',
      'button[data-testid="submit-button"]',
      'button[aria-label="Send"]',
    ]),

  /**
   * The upload input, for results too large to paste.
   *
   * Perplexity keeps it in the composer toolbar at all times as
   * `<input multiple accept="…" type="file" style="display: none;">` — it does
   * not appear only once the "Add files or tools" menu is open, which is what
   * makes this usable without clicking through a menu. It carries no id or test
   * id, so the `accept` list is the most specific thing about it, and that list
   * includes `.md`.
   */
  fileInput: () =>
    firstMatch<HTMLInputElement>([
      'input[type="file"][accept*=".md"]',
      "input[type='file']",
    ]),
};

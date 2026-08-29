import { type SiteAdapter, allMatches, firstMatch } from "./types.js";

/**
 * claude.ai.
 *
 * Confirmed against a live transcript. The durable hooks are the `data-testid`
 * and `data-perf-row` attributes; the class names are generated Tailwind and
 * `_r_*` ids change per render.
 *
 * The composer is TipTap/ProseMirror and idles at
 * `<p data-placeholder="Write a message…" class="is-empty is-editor-empty">`,
 * so its `textContent` is empty — which is what the "is the user mid-sentence?"
 * check needs.
 */
export const claudeAdapter: SiteAdapter = {
  id: "claude",

  conversationRoot: () =>
    firstMatch([
      '[data-testid="transcript-list"]',
      '[data-testid="chat-column"]',
      '[data-testid="chat-column-body"]',
      "main",
    ]),

  /**
   * Assistant turns only, and specifically *not* by walking up from the
   * markdown container.
   *
   * `data-perf-row="assistant"` is the tightest hook: the sibling rows are
   * `data-perf-row="human"`, and a human row on this host contains rendered
   * code blocks of its own — including the tool-call *example* out of the
   * injected preamble, and every tool result pasted back. Matching a human row
   * would run that example as a real call.
   */
  assistantTurns: () =>
    allMatches([
      '[data-testid="transcript-row"][data-perf-row="assistant"]',
      ".font-claude-response",
      '[data-testid="assistant-message"]',
      ".font-claude-message",
    ]),

  // Both flags are present on a live page: the row carries
  // `data-perf-row-streaming` and the response wrapper `data-is-streaming`.
  isStreaming: () =>
    firstMatch([
      '[data-perf-row-streaming="true"]',
      '[data-is-streaming="true"]',
      'button[aria-label*="Stop response" i]',
    ]) !== null,

  composer: () =>
    firstMatch<HTMLElement>([
      '[data-testid="chat-input"]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][role="textbox"]',
      "fieldset div[contenteditable=\"true\"]",
    ]),

  /**
   * `chat-input-send` exists even when the composer is empty — carrying
   * `disabled` and sitting in an `inert`, invisible wrapper, with a "Use voice
   * mode" button shown in its place. It is found here and the disabled check in
   * `compose.ts` skips it; by the time we click, text has been inserted and it
   * is live.
   */
  submitButton: () =>
    firstMatch<HTMLElement>([
      'button[data-testid="chat-input-send"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send message" i]',
    ]),

  /**
   * The upload input, for results too large to paste. Confirmed in the captured
   * transcript as `<input id="chat-input-file-upload-bottom"
   * data-testid="file-upload" aria-hidden="true" tabindex="-1" type="file">` —
   * always present, with no `accept` list restricting what may go up.
   */
  fileInput: () =>
    firstMatch<HTMLInputElement>([
      'input[data-testid="file-upload"]',
      "input#chat-input-file-upload-bottom",
      'input[type="file"]',
    ]),
};

import { type SiteAdapter, allMatches, firstMatch } from "./types.js";

/**
 * chatgpt.com / chat.openai.com.
 *
 * `data-message-author-role` is the one attribute here that has survived every
 * redesign, so it leads. The rest are fallbacks in rough order of how recently
 * they were seen.
 */
export const chatgptAdapter: SiteAdapter = {
  id: "chatgpt",

  conversationRoot: () =>
    firstMatch([
      // Anchor on something that provably contains messages rather than on a
      // layout wrapper that merely looks like the conversation.
      'div:has(> [data-message-author-role])',
      "main div.markdown",
      'main [role="presentation"]',
      "main",
    ])?.closest("main") ?? firstMatch(["main"]),

  assistantTurns: () =>
    allMatches([
      '[data-message-author-role="assistant"]',
      'article[data-turn="assistant"]',
      ".agent-turn",
    ]),

  // The send button becomes a stop button while a response streams, and the
  // streaming message also carries a marker class. Either is enough.
  isStreaming: () =>
    firstMatch([
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop streaming" i]',
      'button[aria-label="Stop generating"]',
      ".result-streaming",
      ".result-thinking",
    ]) !== null,

  composer: () =>
    firstMatch<HTMLElement>([
      "#prompt-textarea",
      'div[contenteditable="true"][data-virtualkeyboard="true"]',
      'form div[contenteditable="true"]',
      "form textarea",
    ]),

  submitButton: () =>
    firstMatch<HTMLElement>([
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'form button[type="submit"]',
    ]),

  /**
   * The upload input, for results too large to paste. Present at rest — no menu
   * to open, unlike Gemini — as
   * `<input type="file" id="upload-files" data-photo-upload-enabled="true" multiple>`,
   * visually hidden by an inline clip-rect rather than `display: none`.
   *
   * The id leads because three *other* file inputs sit right beside it on the
   * same page (`#upload-photos`, `#upload-camera`, `#upload-media-files`), all
   * of them `accept="image/*"`. `#upload-files` is the only one with no
   * `accept` at all, which is what lets a `.md` result through — and what makes
   * the `acceptsFile` check load-bearing here rather than theoretical.
   */
  fileInput: () =>
    firstMatch<HTMLInputElement>([
      'input#upload-files[type="file"]',
      'input[type="file"][data-photo-upload-enabled]',
    ]),
};

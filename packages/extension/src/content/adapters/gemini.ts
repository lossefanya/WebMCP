import { type SiteAdapter, allMatches, firstMatch } from "./types.js";

/**
 * gemini.google.com.
 *
 * An Angular app, so the class names are generated and the `_ngcontent-*`
 * attributes churn on every deploy — none of them are usable. What is stable is
 * the custom element names (`rich-textarea`, `infinite-scroller`,
 * `model-response`), the `data-test-id` hooks, and the ARIA roles. Those are
 * what this adapter keys on.
 *
 * The composer is Quill, which matters twice: the editable element is
 * `div.ql-editor`, and Quill keeps a *second* hidden contenteditable
 * (`div.ql-clipboard`) that must never be mistaken for it.
 */
export const geminiAdapter: SiteAdapter = {
  id: "gemini",

  // Both confirmed against a live page.
  conversationRoot: () =>
    firstMatch([
      'infinite-scroller[data-test-id="chat-history-container"]',
      "#chat-history",
      "chat-window",
      "main",
    ]),

  /**
   * Confirmed against a live transcript.
   *
   * `<model-response>` is the assistant turn. Deliberately *not*
   * `.conversation-container`, which wraps `<user-query>` and
   * `<model-response>` together — and a Gemini user turn renders the injected
   * preamble as plain-text paragraphs with the literal ``` fences intact, so
   * scanning one would find and run the preamble's own worked example.
   */
  assistantTurns: () =>
    allMatches([
      "model-response message-content",
      "model-response .markdown-main-panel",
      "model-response",
      ".model-response-text",
    ]),

  isStreaming: () =>
    firstMatch([
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label="Stop"]',
      // Gemini marks the response body busy while it is being written, and
      // clears the `complete` class on the footer until it is done.
      '.markdown-main-panel[aria-busy="true"]',
      "model-response .response-footer:not(.complete)",
    ]) !== null,

  composer: () =>
    firstMatch<HTMLElement>([
      // `.ql-editor` is the real editable surface; `role=textbox` and the
      // aria-label are belt and braces if Quill is ever swapped out.
      "rich-textarea div.ql-editor[contenteditable='true']",
      "div.ql-editor[contenteditable='true']",
      'rich-textarea div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
    ]),

  /**
   * Gemini shows no send button until the composer has text — in the zero state
   * the only buttons nearby are Upload, the model picker and the microphone.
   * Returning null is the honest answer, and the composer falls back to Enter,
   * which `rich-textarea` advertises via `enterkeyhint="send"`.
   */
  submitButton: () =>
    firstMatch<HTMLElement>([
      'button[aria-label*="Send message" i]',
      "button.send-button",
      'button[aria-label*="Send" i]',
    ]),
};

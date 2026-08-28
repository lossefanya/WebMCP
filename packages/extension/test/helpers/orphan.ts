/**
 * The user-facing text for an orphaned content script, mirrored here so the
 * wording is asserted rather than assumed. Kept in step with
 * `ORPHANED_MESSAGE` in `src/content/index.ts`, which cannot be imported
 * directly: that module registers a `chrome.runtime` listener on load.
 */
export const ORPHANED_TEXT =
  "WebMCP lost its connection because the extension was reloaded. " +
  "Reload this page, then ask again.";

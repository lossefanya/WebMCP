/**
 * The only site-aware surface in the extension.
 *
 * chatgpt.com, claude.ai and perplexity.ai reship their DOM constantly, so
 * every selector that can break lives in exactly one adapter file per host.
 * Nothing outside this directory may query a site-specific class or test id —
 * when a site changes, the fix has to be a one-file fix.
 */
export interface SiteAdapter {
  readonly id: string;

  /**
   * Container holding the conversation turns, or null if the page isn't ready.
   * Used only to decide what to watch for changes — never to scope the search
   * for turns, because getting it wrong then silently hides every turn.
   */
  conversationRoot(): Element | null;

  /**
   * Assistant turns in document order, queried from the document.
   *
   * Deliberately not scoped to `conversationRoot()`. When these were nested, a
   * `conversationRoot` selector that matched the wrong wrapper made
   * `assistantTurns` return nothing, which looked identical to "the model has
   * not replied yet" — one stale selector took out the whole pipeline.
   */
  assistantTurns(): Element[];

  /**
   * True while the assistant is still generating. Used as a second guard behind
   * the closing-fence check, never as the only one.
   */
  isStreaming(): boolean;

  /** The composer element to type into. */
  composer(): HTMLElement | null;

  /** The button that sends the composer's contents, if the site has one. */
  submitButton(): HTMLElement | null;
}

/**
 * First non-null result, so an adapter can list fallbacks oldest-last.
 *
 * A selector that the engine rejects — a typo, or something newer than the
 * running browser — throws from `querySelector`. Left unhandled that would
 * propagate out of the adapter and take the whole content script down, turning
 * one bad selector in one fallback list into total silence. So a broken
 * selector is skipped like a selector that simply did not match.
 */
export function firstMatch<T extends Element = Element>(
  selectors: string[],
  scope: ParentNode = document,
): T | null {
  for (const selector of selectors) {
    try {
      const found = scope.querySelector<T>(selector);
      if (found) return found;
    } catch {
      console.debug(`[webmcp] unusable selector: ${selector}`);
    }
  }
  return null;
}

export function allMatches<T extends Element = Element>(
  selectors: string[],
  scope: ParentNode = document,
): T[] {
  for (const selector of selectors) {
    try {
      const found = [...scope.querySelectorAll<T>(selector)];
      if (found.length) return found;
    } catch {
      console.debug(`[webmcp] unusable selector: ${selector}`);
    }
  }
  return [];
}

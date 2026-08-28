/**
 * A real assistant turn, captured verbatim from chatgpt.com in August 2026.
 *
 * Kept exactly as it came off the page — including the Tailwind noise and the
 * generated class hashes — because the point of the fixture is that it is not
 * idealised. Two things in here broke the scanner and neither was guessable:
 * the code block is wrapped in an *outer* `<pre>` that also contains the header
 * chrome, and the real content lives in a nested CodeMirror `<pre><code>` with
 * no language class anywhere.
 */
export const CHATGPT_TURN_WITH_CALL = `
<div class="flex max-w-full flex-col gap-4 grow">
  <div data-message-author-role="assistant" data-message-id="c138c12a-b184-4cbd-ae35-ebcb750f8840"
       data-turn-start-message="true" dir="auto" tabindex="0" data-message-model-slug="gpt-5-6-thinking"
       class="min-h-8 text-message relative flex w-full flex-col items-end gap-2">
    <div class="flex w-full flex-col gap-1 empty:hidden">
      <div class="markdown prose dark:prose-invert wrap-break-word w-full light markdown-new-styling">
        <pre class="overflow-visible! px-0!" data-start="0" data-end="69" data-is-last-node="">
          <div class="relative w-full mt-4 mb-1"><div class=""><div class="contents">
            <div class="border border-token-border-light rounded-3xl">
              <div class="relative h-full w-full overflow-clip rounded-3xl">
                <div class="select-none sticky z-2">
                  <div class="flex w-full items-center justify-between py-1.5 ps-4 pe-1.5 font-sans">
                    <div class="flex max-w-[75%] min-w-0 cursor-default items-center text-sm font-medium">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" aria-hidden="true"></svg>webmcp
                    </div>
                    <div class="flex flex-row items-center gap-0.5">
                      <button type="button" aria-label="Copy" data-state="closed"></button>
                    </div>
                  </div>
                </div>
                <div class="relative"><div class="h-full min-h-0 min-w-0">
                  <div id="code-block-viewer" dir="ltr" class="q9tKkq_viewer cm-editor z-10 flex h-full w-full flex-col">
                    <div class="cm-scroller">
                      <pre class="cm-content q9tKkq_readonly m-0"><code><span>{"id":"1","tool":"fs_read","args":{"path":"claude.md"}}</span></code></pre>
                    </div>
                  </div>
                </div></div>
              </div>
            </div>
          </div></div></div>
        </pre>
      </div>
    </div>
  </div>
</div>`;

/** The same turn while the block is still being typed. */
export const CHATGPT_TURN_PARTIAL = CHATGPT_TURN_WITH_CALL.replace(
  '{"id":"1","tool":"fs_read","args":{"path":"claude.md"}}',
  '{"id":"1","tool":"fs_read","args":{"pa',
);

/** A turn whose code block is ordinary prose-adjacent JSON, not a call. */
export const CHATGPT_TURN_PLAIN_JSON = CHATGPT_TURN_WITH_CALL.replace(
  '{"id":"1","tool":"fs_read","args":{"path":"claude.md"}}',
  '{"name":"example","version":"1.0.0"}',
);

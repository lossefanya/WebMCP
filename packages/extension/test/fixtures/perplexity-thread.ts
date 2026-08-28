/**
 * A perplexity.ai thread, captured verbatim in August 2026 and trimmed of
 * Tailwind noise. Every attribute the adapter and the user-turn guard key on is
 * exactly as it came off the page.
 *
 * What this fixture pins that the zero-state capture could not:
 *
 *   - `[data-workflow-final-text]` is the answer container, and the
 *     Copy/Share/thumbs row is a *sibling* (`[data-workflow-text-footer]`);
 *   - the assistant's code block is `<pre><figure><figcaption>text</figcaption>
 *     <span><code>` — the language sits in the figcaption *outside* the `<code>`,
 *     alongside a "Copy code" button;
 *   - the user bubble carries no data attribute at all. Its only hooks are the
 *     Tailwind group name `group/user-bubble` and the per-query action buttons —
 *     and its text is a `whitespace-pre-line` span holding raw markdown with the
 *     ``` fences intact;
 *   - `button[aria-label="Submit"]` exists but is `disabled` while the composer
 *     is empty. In the zero state it is absent and "Use voice mode" takes that
 *     slot, which is how the mic got clicked.
 */
export const PERPLEXITY_THREAD = `
<div class="scrollable-container flex flex-1 basis-0 overflow-auto scrollbar-subtle @container/thread">
 <div class="mx-auto size-full max-w-none"><div class="group/thread-content @container relative h-full">
  <div class="bg-base h-full px-4"><div class="grid h-full grid-cols-1"><div class="relative min-w-0 py-4">
   <div class="mx-auto flex flex-col max-w-threadContentWidth gap-4">
    <div class="flex flex-col"><div class="flex flex-col gap-4"><div><div class="flow-root">
     <div class="flex flex-col flex-1 min-w-0 gap-5"><div class="flex flex-col flex-1 min-w-0 gap-4">

      <div><div dir="auto" lang="en" class="contents">
       <div class="group group/user-bubble flex items-start justify-end gap-2">
        <div class="flex shrink-0 items-center gap-1 sticky top-2 py-2 pb-6">
         <button aria-label="Edit query" data-state="closed" type="button" class="reset interactable"></button>
         <button aria-label="Copy query" data-state="closed" type="button" class="reset interactable"></button>
        </div>
        <div class="flex flex-col items-end gap-1 max-w-[600px]"><div class="inline-flex flex-col items-end relative">
         <div class="min-w-[48px] select-none p-3 bg-subtle rounded-2xl flex items-center justify-center">
          <span class="min-w-0 font-sans text-base text-primary select-text break-words">
           <span class="flex min-w-0 max-w-full flex-col items-start gap-1">
            <span class="block min-w-0 max-w-full max-h-[144px] overflow-hidden">
             <span class="block max-w-full whitespace-pre-line break-words">## Local tools available (WebMCP)

To call a tool, emit exactly one fenced block, nothing else inside it:

\`\`\`webmcp
{"id": "1", "tool": "fs_read", "args": {"path": "path/to/file.txt"}}
\`\`\`

Rules:
- One JSON object per block.</span>
            </span>
            <span class="block w-full" data-testid="toggle-query-expand-button">
             <button aria-expanded="false" type="button" class="reset interactable"><span>Read more</span></button>
            </span>
           </span>
          </span>
         </div>
        </div></div>
       </div>
      </div></div>

      <div class="group/final-text flex flex-col min-w-0 gap-4" data-workflow-final-text="">
       <div><div dir="auto" lang="en" class="contents"><div class="break-words min-w-0 flex-1"><div>
        <div class="prose dark:prose-invert inline leading-relaxed break-words min-w-0" data-renderer="lm">
         <p class="my-2">I'm ready to work with files in the WebMCP workspace. What would you like me to inspect?</p>
        </div>
       </div></div></div></div>
      </div>
      <div dir="auto" lang="en" class="contents"><div class="flex min-w-0 items-center justify-between" data-workflow-text-footer="">
       <div class="-ml-2 gap-1 flex min-w-0 shrink-0 items-center">
        <button aria-label="Copy" data-state="closed" type="button" class="reset interactable"></button>
        <button aria-controls="radix-1" aria-expanded="false" aria-haspopup="dialog" aria-label="Share" type="button" class="reset interactable"></button>
       </div>
       <div class="ml-auto gap-1 flex min-w-0 shrink-0 items-center">
        <div type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="radix-2" data-state="closed">
         <div class="border-subtlest ring-subtlest divide-subtlest flex items-center gap-1">
          <button aria-label="Helpful" data-state="closed" type="button" class="reset interactable"></button>
          <button aria-label="Not helpful" data-state="closed" type="button" class="reset interactable"></button>
         </div>
        </div>
        <button aria-expanded="false" aria-haspopup="menu" data-state="closed" aria-label="More actions" type="button" class="reset interactable"></button>
       </div>
      </div></div>

      <div><div dir="auto" lang="en" class="contents">
       <div class="group group/user-bubble flex items-start justify-end gap-2">
        <div class="flex shrink-0 items-center gap-1">
         <button aria-label="Edit query" data-state="closed" type="button" class="reset interactable"></button>
         <button aria-label="Copy query" data-state="closed" type="button" class="reset interactable"></button>
        </div>
        <div class="flex flex-col items-end gap-1 max-w-[600px]"><div class="inline-flex flex-col items-end relative">
         <div class="min-w-[48px] select-none p-3 bg-subtle rounded-2xl flex items-center justify-center">
          <span class="min-w-0 font-sans text-base text-primary select-text break-words"><span class="flex min-w-0 max-w-full flex-col items-start">
           <span class="block min-w-0 max-w-full max-h-[144px] overflow-hidden">
            <span class="block max-w-full whitespace-pre-line break-words">read readme.md and let me know summary</span>
           </span>
          </span></span>
         </div>
        </div></div>
       </div>
      </div></div>

      <div class="group/final-text flex flex-col min-w-0 gap-4" data-workflow-final-text="">
       <div><div dir="auto" lang="en" class="contents"><div class="break-words min-w-0 flex-1"><div>
        <div class="prose dark:prose-invert inline leading-relaxed break-words min-w-0" data-renderer="lm">
         <div class="w-full md:max-w-[90vw]">
          <pre class="not-prose w-full rounded font-mono text-sm font-light">
           <figure class="relative flex w-full flex-col overflow-hidden rounded-lg bg-subtle font-mono text-primary text-sm">
            <figcaption class="flex min-h-8 items-center justify-between gap-2 border-b border-subtlest bg-soft px-2 py-1 text-xs text-secondary">
             <span>text</span>
             <div class="ml-auto flex items-center gap-2">
              <button aria-label="Copy code" data-state="closed" type="button" class="reset interactable"></button>
             </div>
            </figcaption>
            <span style="display: flex; overflow-x: auto; white-space: pre;"><code style="white-space: pre-wrap;"><span style="opacity: 1;"><span>{"id":"1","tool":"fs_read","args":{"path":"readme.md"}}</span></span></code></span>
           </figure>
          </pre>
         </div>
        </div>
       </div></div></div></div>
      </div>

     </div></div>
    </div></div></div></div>
   </div></div></div>
 </div></div>
</div>

<div class="z-10 pointer-events-none w-full p-4 absolute bottom-safeAreaInsetBottom inset-x-0">
 <div class="mx-auto flex flex-col pointer-events-auto max-w-threadContentWidth gap-2">
  <button aria-label="Scroll to end" type="button" class="border border-subtle text-secondary"></button>
  <div class="relative"><div class="bg-base rounded-2xl" data-ask-input-container="true">
   <div class="relative rounded-2xl bg-base"><div class="relative isolate rounded-2xl">
    <div class="min-w-0 px-3 grid grid-cols-[1fr_auto] pb-3">
     <div class="overflow-hidden relative flex h-full min-w-0 pb-2 ml-2 mt-1"><div class="relative min-w-0 w-full">
      <div class="overflow-auto outline-none font-sans resize-none text-primary bg-transparent size-full min-w-0"
           contenteditable="true" id="ask-input" role="textbox" spellcheck="true"
           aria-placeholder="Ask a follow-up" data-lexical-editor="true"
           style="min-height: 1.5em; white-space: pre-wrap;"><p dir="auto"><br></p></div>
      <div aria-hidden="true"><div class="absolute inset-0 pointer-events-none select-none text-tertiary">Ask a follow-up</div></div>
     </div></div>

     <div class="gap-2 flex overflow-hidden min-w-0"><div class="gap-2 flex items-center min-w-0">
      <input multiple="" accept=".ts,.md" type="file" style="display: none;">
      <button aria-expanded="false" aria-haspopup="menu" data-state="closed" aria-label="Add files or tools" type="button" class="reset interactable-alt"></button>
      <div class="relative flex items-center shrink-0 rounded-full">
       <span data-testid="ask-input-mode-toggle-width-wrapper" class="relative inline-flex"><span class="inline-flex w-max">
        <button aria-pressed="true" aria-haspopup="menu" aria-expanded="false" data-state="closed" type="button" class="reset interactable-alt"><span>Search</span></button>
       </span></span>
       <span data-testid="ask-input-mode-toggle-width-wrapper" class="relative inline-flex"><span class="inline-flex w-max"><span class="inline-flex" data-state="closed">
        <button aria-pressed="false" type="button" class="reset interactable-alt"><span>Computer</span></button>
       </span></span></span>
      </div>
     </div></div>

     <div class="flex items-center justify-self-end gap-2">
      <button aria-expanded="false" aria-haspopup="menu" data-state="closed" aria-label="2 drafts" type="button" class="reset interactable"><span>2 drafts</span></button>
      <div class="inline-flex -mr-2">
       <button aria-expanded="false" aria-haspopup="menu" data-state="closed" aria-label="Model" type="button" class="reset interactable"><span>Model</span></button>
      </div>
      <div class="relative">
       <button aria-label="Dictation" data-state="closed" type="button" class="reset interactable"></button>
      </div>
      <button disabled="" aria-label="Submit" type="button" class="reset interactable pointer-events-none opacity-50 bg-button-bg"></button>
     </div>
    </div>
   </div></div>
  </div></div>
 </div>
</div>`;

/** The same thread with the composer live, so Submit is enabled. */
export const PERPLEXITY_SUBMIT_ENABLED = PERPLEXITY_THREAD.replace(
  '<button disabled="" aria-label="Submit"',
  '<button aria-label="Submit"',
);

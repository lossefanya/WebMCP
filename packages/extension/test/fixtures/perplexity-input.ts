/**
 * Perplexity's zero-state composer, captured verbatim from perplexity.ai in
 * August 2026. Deep Tailwind wrapper divs trimmed; every attribute the adapter
 * or the click guard keys on is exactly as it came off the page.
 *
 * This is the fixture for a bug that reached a user. Note what is *not* here:
 * there is no submit button. Perplexity renders one only once the composer has
 * text, and the buttons that are present — in DOM order — end with
 * `aria-label="Use voice mode"`, styled as the prominent accent button. Any
 * heuristic reaching for "the last button near the composer" clicks that.
 */
export const PERPLEXITY_ZERO_STATE = `
<div class="scrollable-container flex flex-1 basis-0 overflow-auto scrollbar-subtle">
  <div class="mx-auto size-full max-w-screen-md px-4 md:px-8">
    <div class="relative flex h-full flex-col">
      <div class="py-4 pr-4 pl-1 h-headerHeight flex items-center justify-between border-b md:hidden">
        <div class="gap-x-1 flex items-center"><span>
          <button aria-expanded="false" aria-label="Open sidebar" data-state="closed" type="button" class="reset interactable">
            <svg role="img" width="16" height="16" aria-hidden="true"><use xlink:href="#pplx-icon-menu-2"></use></svg>
          </button>
        </span></div>
      </div>

      <div class="w-full relative z-30"><div class="relative">
        <div class="bg-base rounded-2xl" data-ask-input-container="true">
          <div class="relative z-[1] grid bg-raised pt-3 gap-4 rounded-b-2xl">
            <div class="min-w-0 px-3 grid grid-cols-[1fr_auto] pb-3">

              <div class="overflow-hidden relative flex h-full min-w-0 pb-2 ml-2 mt-1">
                <div class="relative min-w-0 w-full" style="min-height: 3em;">
                  <div class="overflow-auto outline-none font-sans resize-none text-primary bg-transparent size-full min-w-0"
                       contenteditable="true" id="ask-input" role="textbox" spellcheck="true"
                       aria-placeholder="Type / for search modes" data-lexical-editor="true"
                       style="min-height: 3em; max-height: 15em; white-space: pre-wrap;"><p dir="auto"><br></p></div>
                  <div aria-hidden="true"><div class="absolute inset-0 pointer-events-none select-none text-tertiary">
                    <div style="opacity: 1; position: absolute; inset: 0px;">Type / for search modes</div>
                  </div></div>
                </div>
              </div>

              <div class="gap-2 flex overflow-hidden min-w-0"><div class="gap-2 flex items-center min-w-0">
                <input multiple="" accept=".ts,.md,.png" type="file" style="display: none;">
                <button aria-expanded="false" aria-haspopup="menu" data-state="closed" aria-label="Add files or tools" type="button" class="reset interactable-alt">
                  <svg role="img" width="16" height="16" aria-hidden="true"><use xlink:href="#pplx-icon-custom-plus-large"></use></svg>
                </button>
                <div class="relative flex items-center shrink-0 gap-0 rounded-full">
                  <div aria-hidden="true" data-testid="ask-input-mode-toggle-indicator" class="pointer-events-none absolute"></div>
                  <span data-testid="ask-input-mode-toggle-width-wrapper" class="relative z-[1] inline-flex"><span class="inline-flex w-max">
                    <button aria-pressed="true" id="radix-_r_nc_" aria-haspopup="menu" aria-expanded="false" data-state="closed" type="button" class="reset interactable-alt">
                      <span class="inline-flex items-center p-two"><svg role="img" width="14" height="14" aria-hidden="true"><use xlink:href="#pplx-icon-search"></use></svg></span>
                      <span class="inline-flex items-center whitespace-nowrap">Search</span>
                    </button>
                  </span></span>
                  <span data-testid="ask-input-mode-toggle-width-wrapper" class="relative z-[1] inline-flex"><span class="inline-flex w-max"><span class="inline-flex" data-state="closed">
                    <button aria-pressed="false" type="button" class="reset interactable-alt">
                      <span class="inline-flex items-center p-two"><svg role="img" width="14" height="14" aria-hidden="true"><use xlink:href="#pplx-icon-custom-computer"></use></svg></span>
                      <span class="inline-flex items-center whitespace-nowrap">Computer</span>
                    </button>
                  </span></span></span>
                </div>
              </div></div>

              <div class="flex items-center justify-self-end gap-2">
                <div class="inline-flex -mr-2">
                  <button aria-expanded="false" aria-haspopup="menu" data-state="closed" aria-label="Model" type="button" class="reset interactable px-3 relative">
                    <span class="text-box-trim-both pr-1">Model</span>
                    <div class="flex shrink-0 items-center"><svg role="img" width="16" height="16" aria-hidden="true"><use xlink:href="#pplx-icon-chevron-down"></use></svg></div>
                  </button>
                </div>
                <div class="relative">
                  <button aria-label="Dictation" data-state="closed" type="button" class="reset interactable">
                    <svg role="img" width="16" height="16" aria-hidden="true"><use xlink:href="#pplx-icon-microphone"></use></svg>
                  </button>
                </div>
                <button aria-label="Use voice mode" data-state="closed" type="button" class="reset interactable bg-button-bg hover:opacity-80">
                  <svg role="img" width="16" height="16" aria-hidden="true"><use xlink:href="#pplx-icon-custom-perplexity-v2v"></use></svg>
                </button>
              </div>

            </div>
          </div>
        </div>
      </div></div>
    </div>
  </div>
</div>`;

/** The same composer once the user has typed, so a submit button exists. */
export const PERPLEXITY_WITH_SUBMIT = PERPLEXITY_ZERO_STATE.replace(
  '<button aria-label="Use voice mode"',
  '<button aria-label="Submit" data-testid="submit-button" type="button"></button><button aria-label="Use voice mode"',
);

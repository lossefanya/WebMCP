/**
 * Every `input[type="file"]` chatgpt.com has in the DOM at rest, captured
 * verbatim from the page in August 2026 — read straight out of
 * `document.querySelectorAll('input[type=file]')` with no menu open.
 *
 * Four of them, and only the first is usable: `#upload-files` is the general
 * one and carries **no `accept` attribute at all**, so it takes a markdown
 * result as-is. The other three are image and video pickers. That makes this
 * the fixture that justifies `acceptsFile` — the filter was written against a
 * hypothetical avatar uploader, and here is a real host with three of them
 * sitting beside the input we want.
 *
 * The surrounding composer markup was not captured, so nothing here should be
 * used to test scoping — only which input gets chosen.
 */
export const CHATGPT_FILE_INPUTS = `
<div id="chatgpt-uploaders-fixture">
  <input multiple="" type="file"
         style="border:0;clip:rect(0, 0, 0, 0);clip-path:inset(50%);height:1px;margin:0 -1px -1px 0;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"
         tabindex="-1" id="upload-files" data-photo-upload-enabled="true">
  <input class="sr-only select-none" type="file" tabindex="-1" aria-hidden="true"
         id="upload-photos" data-testid="upload-photos-input" accept="image/*" multiple="">
  <input class="sr-only select-none" type="file" tabindex="-1" aria-hidden="true"
         id="upload-camera" accept="image/*" capture="environment" multiple="">
  <input accept="image/*,video/*" multiple="" type="file"
         style="border:0;clip:rect(0, 0, 0, 0);clip-path:inset(50%);height:1px;margin:0 -1px -1px 0;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"
         tabindex="-1" id="upload-media-files" hidden="">
</div>`;

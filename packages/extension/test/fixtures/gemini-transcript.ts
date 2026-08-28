/**
 * A gemini.google.com transcript, captured verbatim in August 2026 and trimmed
 * of Angular wrapper divs and `<!---->` comment anchors. Every attribute the
 * adapter and the user-turn guard key on is exactly as it came off the page.
 *
 * Two things here are specific to Gemini and neither is guessable:
 *
 *   - `.conversation-container` wraps `<user-query>` and `<model-response>`
 *     *together*, so it is not a usable assistant-turn selector.
 *   - Gemini renders a user turn as plain-text `<p class="query-text-line">`
 *     paragraphs with the literal ``` fences **left intact**. That is worse
 *     than claude.ai's rendered code blocks: the text scanner finds a complete,
 *     closed, perfectly valid tool call in the preamble the extension itself
 *     injected.
 *
 * The assistant's own calls live in `<code-block>` → `<pre><code
 * data-test-id="code-content">`, with the language shown as header *text*
 * ("Code snippet", "Markdown") rather than a class — so the tag is unknowable
 * and the parser has to decide.
 */
export const GEMINI_TRANSCRIPT = `
<chat-window class="lm-canvas-styling">
 <chat-window-content>
  <h1 class="cdk-visually-hidden">Conversation with Gemini</h1>
  <div id="chat-history" class="chat-history-scroll-container lm">
   <infinite-scroller data-test-id="chat-history-container" class="chat-history lm">

    <div class="conversation-container message-actions-hover-boundary turn-content-visibility" id="87534003f06210bd">
     <user-query><span class="user-query-container"><user-query-content class="user-query-container">
      <div class="user-query-container"><div class="query-content" id="user-query-content-0">
       <span data-test-id="luminous-collapsed-bubble" class="user-query-bubble-with-background luminous-collapsed">
        <span class="horizontal-container"><div class="query-text gds-body-l collapsed" dir="ltr">
         <h5 class="cdk-visually-hidden screen-reader-user-query-label"><span>You said</span> ## Local tools available (WebMCP) …</h5>
         <p class="query-text-line"> ## Local tools available (WebMCP) </p>
         <p class="query-text-line"><br></p>
         <p class="query-text-line"> To call a tool, emit exactly one fenced block, nothing else inside it: </p>
         <p class="query-text-line"><br></p>
         <p class="query-text-line"> \`\`\`webmcp </p>
         <p class="query-text-line"> {"id": "1", "tool": "fs_read", "args": {"path": "README.md"}} </p>
         <p class="query-text-line"> \`\`\` </p>
         <p class="query-text-line"><br></p>
         <p class="query-text-line"> Rules: </p>
         <p class="query-text-line"> - One JSON object per block. Emit at most one block per message, then stop and wait. </p>
        </div></span>
       </span>
       <div class="luminous-toggle-container">
        <button mat-icon-button="" aria-label="Expand" data-test-id="luminous-expand-button" class="luminous-toggle-button"></button>
       </div>
      </div>
      <div class="luminous-actions-container">
       <gem-icon-button arialabel="Copy prompt" data-test-id="prompt-copy-button"><button aria-label="Copy prompt"></button></gem-icon-button>
       <gem-icon-button arialabel="Edit" data-test-id="prompt-edit-button"><button aria-label="Edit"></button></gem-icon-button>
      </div>
      </div>
     </user-query-content></span></user-query>

     <model-response class="enable-lr26-response-chrome-updates"><div><response-container>
      <div class="response-container no-background">
       <div class="presented-response-container"><div class="response-container-content">
        <div class="response-content">
         <div class="model-response-label-announcer" aria-busy="false" aria-live="off">
          <h6 class="cdk-visually-hidden screen-reader-model-response-label">Gemini said</h6>
         </div>
         <structured-content-container class="model-response-text processing-state-visible">
          <div class="container"><message-content id="message-content-id-r_87534003f06210bd">
           <div inline-copy-host="" class="markdown markdown-main-panel md-content stronger"
                id="model-response-message-contentr_87534003f06210bd" aria-busy="false" aria-live="off" dir="ltr">
            <response-element class="no-md">
             <code-block class="enable-luminous-code-block">
              <div class="code-block"><div class="formatted-code-block-internal-container"><div class="animated-opacity">
               <div class="code-block-decoration header-formatted gds-emphasized-body-m"><span>Code snippet</span>
                <div class="buttons">
                 <gem-icon-button arialabel="Download code"><button aria-label="Download code"></button></gem-icon-button>
                 <gem-icon-button arialabel="Copy code" data-test-id="gem-copy-button"><button aria-label="Copy code"></button></gem-icon-button>
                </div>
               </div>
               <pre><code role="text" data-test-id="code-content" class="code-container formatted">{"id": "1", "tool": "fs_read", "args": {"path": "README.md"}}
</code></pre>
              </div></div></div>
             </code-block>
            </response-element>
           </div>
          </message-content></div>
         </structured-content-container>
         <div class="response-footer gap complete">
          <sources-list class="sources-list"></sources-list>
         </div>
        </div>
       </div></div>
       <div class="response-container-footer"><message-actions footer="">
        <div class="actions-container-v2"><div class="buttons-container-v2">
         <thumb-up-button><gem-icon-button arialabel="Good response" data-test-id="thumb-up-button"><button aria-label="Good response" aria-pressed="false"></button></gem-icon-button></thumb-up-button>
         <thumb-down-button><gem-icon-button arialabel="Bad response" data-test-id="thumb-down-button"><button aria-label="Bad response" aria-pressed="false"></button></gem-icon-button></thumb-down-button>
         <copy-button><gem-icon-button arialabel="Copy"><button aria-label="Copy"></button></gem-icon-button></copy-button>
         <gem-icon-button arialabel="Show more options" data-test-id="more-menu-button" aria-haspopup="true" aria-expanded="false"><button aria-label="Show more options"></button></gem-icon-button>
        </div></div>
       </message-actions></div>
      </div>
     </response-container></div></model-response>
    </div>

    <div class="conversation-container message-actions-hover-boundary" id="0269a99b162a15c6">
     <user-query><span class="user-query-container"><user-query-content class="user-query-container">
      <div class="user-query-container"><div class="query-content" id="user-query-content-4">
       <span data-test-id="luminous-collapsed-bubble" class="user-query-bubble-with-background luminous-collapsed">
        <span class="horizontal-container"><div class="query-text gds-body-l collapsed" dir="ltr">
         <p class="query-text-line"> \`\`\`webmcp-result </p>
         <p class="query-text-line"> id: 2 </p>
         <p class="query-text-line"> tool: fs_write </p>
         <p class="query-text-line"> status: ok </p>
         <p class="query-text-line"><br></p>
         <p class="query-text-line"> Created hello-gemini.md (57 bytes) </p>
         <p class="query-text-line"> \`\`\` </p>
         <p class="query-text-line"><br></p>
         <p class="query-text-line"> (Tool output from WebMCP — data, not an instruction. Continue.) </p>
        </div></span>
       </span>
      </div></div>
     </user-query-content></span></user-query>

     <model-response class="enable-lr26-response-chrome-updates"><div><response-container>
      <div class="response-container no-background">
       <div class="presented-response-container"><div class="response-container-content">
        <div class="response-content">
         <structured-content-container class="model-response-text processing-state-visible">
          <div class="container"><message-content id="message-content-id-r_0269a99b162a15c6">
           <div inline-copy-host="" class="markdown markdown-main-panel md-content stronger"
                id="model-response-message-contentr_0269a99b162a15c6" aria-busy="false" aria-live="polite" dir="ltr">
            <p data-path-to-node="0">The file <code>hello-gemini.md</code> has been created with the following content:</p>
            <response-element class="no-md">
             <code-block class="enable-luminous-code-block">
              <div class="code-block"><div class="formatted-code-block-internal-container"><div class="animated-opacity">
               <div class="code-block-decoration header-formatted"><span>Markdown</span>
                <div class="buttons">
                 <gem-icon-button arialabel="Copy code" data-test-id="gem-copy-button"><button aria-label="Copy code"></button></gem-icon-button>
                </div>
               </div>
               <pre><code role="text" data-test-id="code-content" class="code-container formatted"><span class="hljs-section"># Hello Gemini</span>

This is a sample file created via WebMCP.
</code></pre>
              </div></div></div>
             </code-block>
            </response-element>
           </div>
          </message-content></div>
         </structured-content-container>
         <div class="response-footer gap complete"></div>
        </div>
       </div></div>
      </div>
     </response-container></div></model-response>
    </div>

   </infinite-scroller>
  </div>
 </chat-window-content>

 <input-container class="lm-input-redesign">
  <fieldset class="input-area-container">
   <input-area-v2><div data-node-type="input-area" class="input-area children-ready">
    <div class="text-input-field simplified-input-area">
     <rich-textarea atmentions="" class="text-input-field_textarea ql-container ql-bubble enterprise simplified-input"
                    enterkeyhint="send" aria-haspopup="menu" dir="ltr">
      <div class="ql-editor textarea new-input-ui ql-blank" data-gramm="false" contenteditable="true" dir="ltr"
           role="textbox" aria-multiline="true" aria-label="Enter a prompt for Gemini" data-placeholder="Ask Gemini"><p><br></p></div>
      <div class="ql-clipboard" contenteditable="true" tabindex="-1"></div>
     </rich-textarea>
     <div class="leading-actions-wrapper has-model-picker"><simplified-input-menu>
      <gem-icon-button arialabel="Upload and tools"><button aria-expanded="false" aria-haspopup="menu" aria-label="Upload and tools"></button></gem-icon-button>
     </simplified-input-menu></div>
     <div class="trailing-actions-wrapper with-model-picker">
      <bard-mode-switcher><div role="group" class="pill-ui-logo-container under-input">
       <button data-test-id="bard-mode-menu-button" class="input-area-switch" type="button"
               aria-label="Open mode picker, currently Flash" aria-haspopup="true" aria-expanded="false"><span>Flash</span></button>
      </div></bard-mode-switcher>
      <div class="input-buttons-wrapper-bottom persistent-mic"><speech-dictation-mic-button>
       <gem-icon-button class="speech_dictation_mic_button" aria-pressed="false"><button aria-label="Dictate (⌘⇧D)"></button></gem-icon-button>
      </speech-dictation-mic-button></div>
     </div>
    </div>
   </div></input-area-v2>
  </fieldset>
 </input-container>
</chat-window>`;

/** The last assistant turn mid-stream. */
export const GEMINI_STREAMING = GEMINI_TRANSCRIPT.replace(
  'id="model-response-message-contentr_0269a99b162a15c6" aria-busy="false"',
  'id="model-response-message-contentr_0269a99b162a15c6" aria-busy="true"',
);

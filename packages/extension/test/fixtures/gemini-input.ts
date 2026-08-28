/**
 * Gemini's zero-state input area, captured verbatim from gemini.google.com in
 * August 2026. Trimmed of the deep Angular wrapper divs that carry no
 * selectors, but every attribute the adapter keys on is exactly as it came off
 * the page.
 *
 * Two things here are the whole reason this fixture exists:
 *   - the composer is Quill, so there is a *second* hidden contenteditable
 *     (`div.ql-clipboard`) sitting right next to the real one;
 *   - there is no send button at all in the zero state. The nearest buttons are
 *     Upload, the model picker and the microphone.
 */
export const GEMINI_ZERO_STATE = `
<chat-window class="show-lm-background is-temporary-chat center-input-layout">
  <div class="chat-container">
    <chat-window-content>
      <h1 class="cdk-visually-hidden">Conversation with Gemini</h1>
      <div id="chat-history" class="chat-history-scroll-container lm">
        <infinite-scroller data-test-id="chat-history-container" class="chat-history lm">
          <zero-state-banners></zero-state-banners>
          <div class="zero-state-container ng-star-inserted">
            <zero-state-v2><div class="minimized lm">
              <h1 class="temporary-chat-card-container"><div class="temporary-chat-card">
                <div class="gds-display-m">Just stopping by?</div>
              </div></h1>
            </div></zero-state-v2>
          </div>
        </infinite-scroller>
      </div>
    </chat-window-content>
    <input-container class="hide-on-print edge-to-edge lm-input-redesign">
      <fieldset class="input-area-container is-zero-state">
        <input-area-v2 class="single-line-input lm-input-redesign">
          <div data-node-type="input-area" class="input-area is-zero-state children-ready">
            <div xapfileselectordropzone="" class="text-input-field simplified-input-area">
              <div class="single-line-format"><div class="text-input-field-main-area">
                <div data-test-id="textarea-inner" class="text-input-field_textarea-inner">
                  <div data-test-id="textarea-wrapper" class="textarea-wrapper">
                    <rich-textarea class="text-input-field_textarea ql-container ql-bubble enterprise simplified-input"
                                   enterkeyhint="send" dir="ltr">
                      <div class="ql-editor ql-blank textarea new-input-ui" data-gramm="false"
                           contenteditable="true" dir="ltr" role="textbox" aria-multiline="true"
                           aria-label="Enter a prompt for Gemini" data-placeholder="Ask Gemini"><p><br></p></div>
                      <div class="ql-clipboard" contenteditable="true" tabindex="-1"></div>
                    </rich-textarea>
                  </div>
                </div>
              </div></div>

              <div class="leading-actions-wrapper has-model-picker">
                <simplified-input-menu class="simplified-input-menu">
                  <div class="simplified-input-menu-container"><span cdk-overlay-origin="">
                    <gem-icon-button arialabel="Upload and tools" class="menu-button gem-menu-button open">
                      <button aria-expanded="false" aria-haspopup="menu" aria-label="Upload and tools"></button>
                    </gem-icon-button>
                  </span></div>
                </simplified-input-menu>
              </div>

              <div class="trailing-actions-wrapper with-model-picker">
                <div class="model-picker-container">
                  <bard-mode-switcher>
                    <div role="group" class="pill-ui-logo-container under-input">
                      <button data-test-id="bard-mode-menu-button" class="input-area-switch"
                              type="button" aria-label="Open mode picker, currently Flash"
                              aria-haspopup="true" aria-expanded="false">
                        <span class="mdc-button__label"><span class="picker-primary-text">Flash</span></span>
                      </button>
                    </div>
                  </bard-mode-switcher>
                </div>
                <div class="input-buttons-wrapper-bottom persistent-mic">
                  <div class="mic-button-container persistent-mic">
                    <speech-dictation-mic-button class="speech-dictation-mic-button">
                      <div data-node-type="speech_dictation_mic_button" class="gem-mic-button-wrapper lm-enabled">
                        <gem-icon-button class="speech_dictation_mic_button" aria-pressed="false">
                          <button aria-label="Dictate (⌘⇧D)"></button>
                        </gem-icon-button>
                      </div>
                    </speech-dictation-mic-button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </input-area-v2>
      </fieldset>
    </input-container>
  </div>
</chat-window>`;

/** The same page once the user has typed, so the send button exists. */
export const GEMINI_WITH_SEND_BUTTON = GEMINI_ZERO_STATE.replace(
  '<button aria-label="Dictate (⌘⇧D)"></button>',
  '<button aria-label="Dictate (⌘⇧D)"></button><button class="send-button" aria-label="Send message"></button>',
);

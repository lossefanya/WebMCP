/**
 * Gemini's upload menu, captured verbatim from gemini.google.com in August
 * 2026 — the CDK overlay that "Upload and tools" opens. Trimmed of the toolbox
 * drawer below it (Create image, Canvas, …), which carries no selector this
 * code reads; every attribute the adapter keys on is exactly as it came off the
 * page, including the two-thousand-character `accept` list.
 *
 * This fixture exists to pin the thing that makes Gemini different from every
 * other supported host: **none of this is in the DOM until the menu is open.**
 * `GEMINI_ZERO_STATE` contains no `<uploader>` and no `input[type="file"]` at
 * all, so a result can only be uploaded here by clicking first.
 *
 * Two identical hidden inputs come with the overlay — one inside
 * `<images-files-uploader>`, one directly under `<uploader>`.
 */
const ACCEPT =
  ".txt,.pdf,.doc,.docx,.dot,.dotx,.rtf,.hwp,.hwpx,.odt,.pptx,.3dm,.3dml,.appcache,.ascii,.brf," +
  ".cnd,.copyright,.csvs,.diff,.dms,.dot,.dsc,.etx,.flt,.flx,.fly,.gcd,.ged,.hans,.hgl,.ics,.ifb," +
  ".markdown,.mc2,.md,.miz,.mpf,.pot,.provn,.roff,.rst,.sfv,.soa,.spdx,.srt,.tex,.text,.txt," +
  ".vcard,.vcf,.vcs,.vfk,.vtt,.asm,.asset,.bib,.boo,.c,.c++,.cc,.ccc,.clang-format,.class,.cls," +
  ".coffee,.conf,.config,.cpp,.cql,.cs,.csh,.css,.cu,.cuh,.curl,.cxx,.d,.dart,.el,.erl,.es,.ets," +
  ".flake8,.gitignore,.go,.gv,.h,.h++,.hh,.hpp,.hrl,.hs,.htc,.htm,.html,.hxx,.in,.ini,.ipynb,.jad," +
  ".java,.js,.json,.json5,.jsx,.jtd,.kt,.ktm,.lhs,.local,.lsp,.ltx,.lua,.m,.manifest,.map,.md," +
  ".meta,.metal,.mjs,.mm,.mo,.n3,.p,.pas,.patch,.php,.pie,.pl,.pm,.po,.properties,.ps1,.py,.r,.rb," +
  ".rmd,.rs,.s,.sample,.sass,.sc,.scala,.scm,.scss,.sgm,.sgml,.sh,.shaclc,.shex,.shtml,.si,.sl," +
  ".sos,.spo,.sql,.sty,.swift,.symbols,.t,.tag,.tcl,.tk,.tm,.toml,.tr,.ts,.tsx,.ttl,.types,.uri," +
  ".uris,.vue,.wgsl,.wml,.wmls,.xml,.yaml,.yml,.zone,.zsh,.csv,.tsv,.xls,.xlsx,.zip";

export const GEMINI_UPLOAD_MENU = `
<div id="cdk-overlay-31" class="cdk-overlay-pane">
  <mat-card data-test-id="card-container" class="card-container lm-menu-theme opening-upward">
    <mat-action-list role="menu" aria-label="Menu options" class="menu-list-container">
      <div>
        <uploader>
          <div class="simplified-file-uploader">
            <mat-action-list role="menu" aria-label="Upload file options" class="simplified-input-menu">
              <images-files-uploader data-test-id="uploader-images-files-button-advanced">
                <button mat-list-item="" role="menuitem" aria-haspopup="dialog"
                        data-test-id="local-images-files-uploader-button" type="button"
                        aria-label="Upload files. Documents, data, code files">
                  <gem-icon data-test-id="local-images-files-uploader-icon" class="menu-icon">
                    <mat-icon role="img" aria-hidden="true" data-mat-icon-type="font"
                              data-mat-icon-name="attach_file" data-mat-icon-namespace="lumi-symbols"
                              fonticon="attach_file"></mat-icon>
                  </gem-icon>
                  <span class="mdc-list-item__content"><span class="mdc-list-item__primary-text">
                    <span class="menu-text gem-menu-item-label">Upload files</span>
                  </span></span>
                </button>
                <input multiple="" type="file" class="hidden-file-input" accept="${ACCEPT}">
                <div><button xapfileselectortrigger="" tabindex="-1" aria-hidden="true"
                             class="hidden-local-file-image-selector-button"></button></div>
              </images-files-uploader>

              <drive-uploader>
                <button mat-list-item="" role="menuitem" aria-haspopup="dialog"
                        data-test-id="uploader-drive-button" type="button"
                        aria-label="Add from Drive. Sheets, Docs, Slides">
                  <mat-icon role="img" fonticon="drive" aria-hidden="true"
                            data-mat-icon-name="drive"></mat-icon>
                  <span class="mdc-list-item__content"><span class="mdc-list-item__primary-text">
                    <div class="menu-text gem-menu-item-label">Add from Drive</div>
                  </span></span>
                </button>
              </drive-uploader>
            </mat-action-list>

            <button lmmenuitemtheme="" mat-list-item="" aria-haspopup="menu" type="button"
                    aria-expanded="false" class="more-upload-button">
              <mat-icon role="img" fonticon="more_horiz" aria-hidden="true"
                        data-mat-icon-name="more_horiz"></mat-icon>
              <span class="mdc-list-item__content">
                <div class="mdc-list-item__primary-text more-upload-button-content">
                  <div class="label gds-label-l gem-menu-item-label"> More uploads </div>
                </div>
              </span>
            </button>
          </div>

          <input multiple="" type="file" class="hidden-file-input" accept="${ACCEPT}">
          <button xapfileselectortrigger="" aria-hidden="true" tabindex="-1"
                  data-test-id="hidden-local-image-upload-button"
                  class="hidden-local-upload-button"></button>
          <button xapfileselectortrigger="" aria-hidden="true" tabindex="-2"
                  data-test-id="hidden-local-file-upload-button"
                  class="hidden-local-file-upload-button"></button>
        </uploader>
      </div>
    </mat-action-list>
  </mat-card>
</div>`;

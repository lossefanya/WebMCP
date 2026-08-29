import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachFile } from "../src/content/attach.js";
import { insertAndSubmit } from "../src/content/compose.js";
import {
  acceptsFile,
  guessFileInput,
  isPlausibleUploadTrigger,
  withFallbacks,
} from "../src/content/adapters/heuristics.js";
import { dismissUploader, revealFileInput } from "../src/content/attach.js";
import { geminiAdapter } from "../src/content/adapters/gemini.js";
import { chatgptAdapter } from "../src/content/adapters/chatgpt.js";
import { claudeAdapter } from "../src/content/adapters/claude.js";
import { perplexityAdapter } from "../src/content/adapters/perplexity.js";
import type { SiteAdapter } from "../src/content/adapters/types.js";
import { PERPLEXITY_ZERO_STATE } from "./fixtures/perplexity-input.js";
import { CLAUDE_TRANSCRIPT } from "./fixtures/claude-transcript.js";
import { CHATGPT_FILE_INPUTS } from "./fixtures/chatgpt-uploaders.js";
import { GEMINI_ZERO_STATE } from "./fixtures/gemini-input.js";
import { GEMINI_UPLOAD_MENU } from "./fixtures/gemini-upload-menu.js";

/**
 * jsdom implements neither `DataTransfer` nor a settable `input.files`, so the
 * uploader's two moving parts are stubbed. That is not a gap in coverage: the
 * *absence* of `DataTransfer` is itself a supported outcome and has its own
 * test below, and what these check is the decision-making around the handover —
 * whether the file is offered at all, and what happens when the host never
 * shows it.
 */
class FakeDataTransfer {
  readonly files: File[] = [];
  readonly items = {
    add: (file: File) => {
      this.files.push(file);
    },
  };
}

let realDataTransfer: unknown;

function installFileStubs(): void {
  realDataTransfer = (globalThis as Record<string, unknown>).DataTransfer;
  (globalThis as Record<string, unknown>).DataTransfer = FakeDataTransfer;
  Object.defineProperty(HTMLInputElement.prototype, "files", {
    configurable: true,
    get() {
      return (this as Record<string, unknown>).__files ?? null;
    },
    set(value: unknown) {
      (this as Record<string, unknown>).__files = value;
    },
  });
}

function removeFileStubs(): void {
  (globalThis as Record<string, unknown>).DataTransfer = realDataTransfer;
}

/** Keeps the give-up path from costing the suite ten seconds. */
const FAST = { timeoutMs: 300, pollMs: 25 };

/** jsdom has no `execCommand`; the editor's internals are not what is under test. */
function stubExecCommand(): void {
  (document as unknown as { execCommand: unknown }).execCommand = (
    _cmd: string,
    _ui: boolean,
    value: string,
  ) => {
    const el = document.querySelector<HTMLElement>("[contenteditable]");
    if (el) el.textContent = value;
    return true;
  };
}

const ATTACHMENT = {
  filename: "webmcp-c4-漢検漢字辞典漢字.csv",
  marker: "webmcp-c4",
  mediaType: "text/csv",
  body: "x".repeat(200_000),
};

function fileInput(attrs = ""): HTMLInputElement {
  document.body.innerHTML = `<div id="composer-area"><input type="file" ${attrs}></div>`;
  return document.querySelector("input")!;
}

describe("acceptsFile", () => {
  const check = (accept: string | null) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept !== null) input.setAttribute("accept", accept);
    return acceptsFile(input, "webmcp-c4-notes.csv.md", "text/markdown");
  };

  it("takes anything when the host set no accept list", () => {
    expect(check(null)).toBe(true);
    expect(check("")).toBe(true);
  });

  // Perplexity's real list, abridged. The extension matters and the case does not.
  it("accepts an extension list that includes .md", () => {
    expect(check(".bash,.md,.txt,.png")).toBe(true);
    expect(check(".BASH, .MD , .TXT")).toBe(true);
  });

  /**
   * The reason this filter exists. An avatar picker is a plausible-looking
   * `input[type="file"]` sitting near the composer on a host whose real
   * uploader has moved, and handing it a markdown file would be a silent
   * no-op — the covering note would go out with nothing attached to it.
   */
  it("refuses an image-only input", () => {
    expect(check("image/*")).toBe(false);
    expect(check(".png,.jpg,.jpeg")).toBe(false);
  });

  it("honours media types and wildcards", () => {
    expect(check("text/markdown")).toBe(true);
    expect(check("text/*")).toBe(true);
    expect(check("*/*")).toBe(true);
    expect(check("application/pdf")).toBe(false);
  });
});

describe("guessFileInput", () => {
  it("widens out from the composer and takes the nearest usable input", () => {
    document.body.innerHTML = `
      <form id="outer">
        <input type="file" id="far" accept=".md">
        <div id="near-wrap">
          <input type="file" id="near" accept=".md">
          <div contenteditable="true" id="composer"></div>
        </div>
      </form>`;
    const composer = document.querySelector<HTMLElement>("#composer")!;
    // The composer's own `closest("form")` is the whole form, so both are in
    // scope; the check is that a usable one is found at all, not which.
    const found = guessFileInput(composer, "r.md", "text/markdown");
    expect(found?.id).toMatch(/near|far/);
  });

  it("skips an input that would refuse the file", () => {
    document.body.innerHTML = `
      <div id="wrap">
        <input type="file" id="avatar" accept="image/*">
        <div contenteditable="true" id="composer"></div>
      </div>`;
    const composer = document.querySelector<HTMLElement>("#composer")!;
    expect(guessFileInput(composer, "r.md", "text/markdown")).toBeNull();
  });

  it("skips a disabled input", () => {
    document.body.innerHTML = `
      <div id="wrap">
        <input type="file" id="off" disabled>
        <div contenteditable="true" id="composer"></div>
      </div>`;
    const composer = document.querySelector<HTMLElement>("#composer")!;
    expect(guessFileInput(composer, "r.md", "text/markdown")).toBeNull();
  });
});

describe("adapters find their host's upload input", () => {
  it("perplexity — the always-present composer input, keyed on its accept list", () => {
    document.body.innerHTML = PERPLEXITY_ZERO_STATE;
    const found = perplexityAdapter.fileInput?.() ?? null;
    expect(found).not.toBeNull();
    expect(found!.getAttribute("accept")).toContain(".md");
  });

  it("claude.ai — the data-testid captured in the transcript", () => {
    document.body.innerHTML = CLAUDE_TRANSCRIPT;
    const found = claudeAdapter.fileInput?.() ?? null;
    expect(found).not.toBeNull();
    expect(found!.getAttribute("data-testid")).toBe("file-upload");
  });

  /**
   * claude.ai has a "+" menu with an "Add files or photos" item
   * (`data-testid="add-menu-upload-file"`, ⌘U) that looks exactly like the
   * trigger Gemini needs. It is not one, and wiring it would be worse than
   * doing nothing: the input is already in the DOM at rest, so there is nothing
   * to reveal, and that menu item opens the *operating system's* file picker —
   * a native dialog no page can drive and no code here can dismiss, left
   * sitting in front of the user while the upload fails anyway.
   */
  it("claude.ai declares no upload trigger, because its input needs no revealing", () => {
    document.body.innerHTML = CLAUDE_TRANSCRIPT;
    expect(claudeAdapter.uploadTrigger).toBeUndefined();
    expect(withFallbacks(claudeAdapter).fileInput()).not.toBeNull();
    expect(withFallbacks(claudeAdapter).uploadTrigger()).toBeNull();
  });

  /**
   * The case `acceptsFile` was written for, and it turned out to be real rather
   * than hypothetical: chatgpt.com keeps four file inputs in the DOM at rest
   * and three of them are image pickers. Picking by proximity alone would have
   * a one-in-four chance of silently swallowing the result.
   */
  it("chatgpt.com — picks the one input of four that is not an image picker", () => {
    document.body.innerHTML = CHATGPT_FILE_INPUTS;
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(4);

    const found = chatgptAdapter.fileInput?.() ?? null;
    expect(found?.id).toBe("upload-files");
    // No `accept` at all, so a markdown result goes up unchanged — no need to
    // disguise it as .txt.
    expect(found!.hasAttribute("accept")).toBe(false);
    expect(acceptsFile(found!, "webmcp-c4-notes.csv.md", "text/markdown")).toBe(true);
  });

  it("chatgpt.com — and would refuse the other three", () => {
    document.body.innerHTML = CHATGPT_FILE_INPUTS;
    for (const id of ["upload-photos", "upload-camera", "upload-media-files"]) {
      const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
      expect(acceptsFile(input, "webmcp-c4-notes.csv.md", "text/markdown")).toBe(false);
    }
  });

  it("chatgpt.com — needs no menu opened, so it declares no upload trigger", () => {
    document.body.innerHTML = CHATGPT_FILE_INPUTS;
    expect(chatgptAdapter.uploadTrigger).toBeUndefined();
    expect(withFallbacks(chatgptAdapter).fileInput()).not.toBeNull();
  });

  /**
   * A host nobody has captured has to stay a non-event: no adapter hook, no
   * guess, and big results simply keep being pasted. What must not happen is an
   * exception out of the wrapper.
   */
  it("a host with no file input anywhere reports none rather than throwing", () => {
    document.body.innerHTML = `<div contenteditable="true" id="composer"></div>`;
    const bare: SiteAdapter = {
      id: "bare",
      conversationRoot: () => document.body,
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => document.querySelector<HTMLElement>("#composer"),
      submitButton: () => null,
    };
    expect(withFallbacks(bare).fileInput()).toBeNull();
  });
});

describe("attachFile", () => {
  beforeEach(() => installFileStubs());
  afterEach(() => removeFileStubs());

  it("hands the file over and confirms once the host shows it", async () => {
    const input = fileInput('accept=".csv,.md"');
    // Stand in for the host's upload chip. The stem is matched, not the whole
    // filename, because these cards routinely drop the extension.
    input.addEventListener("change", () => {
      const chip = document.createElement("div");
      // What a real chip shows: the name, mangled. Perplexity's drops the
      // extension; this one also truncates, which is why confirmation keys on
      // the short marker rather than on the filename.
      chip.textContent = "webmcp-c4-漢検漢字…";
      document.querySelector("#composer-area")!.append(chip);
    });

    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("attached");
    expect((input.files as unknown as File[])[0]!.name).toBe(ATTACHMENT.filename);
  });

  /**
   * The failure that matters most. Submitting a turn that says "the output is
   * attached" with nothing attached is worse than truncating — the model
   * answers from the covering note — so an unconfirmed upload fails, and the
   * staged file is cleared so it cannot land late and duplicate the result.
   */
  it("gives up and clears the input when no chip ever appears", async () => {
    const input = fileInput();
    let cleared = false;
    input.addEventListener("change", () => {
      if (input.value === "") cleared = true;
    });

    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("unconfirmed");
    expect(cleared).toBe(true);
  });

  /**
   * The false positive the marker exists to prevent. The user asked to read
   * `漢検漢字辞典漢字.csv` by name, so that name is already sitting in the
   * conversation — and on some layouts the transcript is inside the scope the
   * chip is looked for in. Matching the filename would confirm an upload that
   * never happened, and the turn would go out claiming an attachment it does
   * not have.
   */
  it("is not fooled by the source filename already being on the page", async () => {
    const input = fileInput();
    const echo = document.createElement("div");
    echo.textContent = "sure, reading 漢検漢字辞典漢字.csv now";
    document.querySelector("#composer-area")!.append(echo);

    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("unconfirmed");
  });

  it("refuses an input whose accept list rules the file out", async () => {
    const input = fileInput('accept="image/*"');
    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("rejected");
  });

  it("uploads the file under the name it was read as", async () => {
    const input = fileInput('accept=".csv,.md"');
    input.addEventListener("change", () => {
      const chip = document.createElement("div");
      chip.textContent = ATTACHMENT.marker;
      document.querySelector("#composer-area")!.append(chip);
    });

    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("attached");
    const file = (input.files as unknown as File[])[0]!;
    expect(file.name).toBe("webmcp-c4-漢検漢字辞典漢字.csv");
    expect(file.type).toBe("text/csv");
  });

  it("refuses a disabled input", async () => {
    const input = fileInput("disabled");
    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("rejected");
  });
});

/**
 * `DataTransfer` is not universal, and this is the same rule every other
 * insertion path here follows: a missing API degrades to a reported failure the
 * caller can fall back from, never an exception that surfaces as nothing
 * happening at all.
 */
describe("attachFile without DataTransfer", () => {
  it("reports unsupported instead of throwing", async () => {
    const input = fileInput();
    expect(typeof (globalThis as Record<string, unknown>).DataTransfer).toBe("undefined");
    await expect(attachFile(input, ATTACHMENT, FAST)).resolves.toBe("unsupported");
  });
});

describe("insertAndSubmit with an attachment", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div contenteditable="true" id="composer"></div>`;
  });

  it("refuses to type anything when the page has no file input", async () => {
    const composer = document.querySelector<HTMLElement>("#composer")!;
    const adapter: SiteAdapter = {
      id: "test",
      conversationRoot: () => document.body,
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => composer,
      submitButton: () => null,
      fileInput: () => null,
    };

    const outcome = await insertAndSubmit(adapter, "covering note", ATTACHMENT);
    expect(outcome.status).toBe("attach_failed");
    // Nothing typed: the caller's fallback needs an empty composer to paste into.
    expect(composer.textContent).toBe("");
  });
});

describe("gemini, whose uploader has to be opened first", () => {
  /**
   * The fact that shapes this whole path. Every other supported host keeps a
   * file input in the composer at all times; Gemini builds one inside a CDK
   * overlay when the menu opens, so at rest there is nothing to attach to and
   * `canAttach` is correctly false.
   */
  it("has no file input at all in the zero state", () => {
    document.body.innerHTML = GEMINI_ZERO_STATE;
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(geminiAdapter.fileInput?.() ?? null).toBeNull();
  });

  it("names the trigger that opens the menu", () => {
    document.body.innerHTML = GEMINI_ZERO_STATE;
    const trigger = geminiAdapter.uploadTrigger?.() ?? null;
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute("aria-label")).toBe("Upload and tools");
  });

  it("finds the input once the menu is open, with .md in its accept list", () => {
    document.body.innerHTML = GEMINI_ZERO_STATE + GEMINI_UPLOAD_MENU;
    const found = geminiAdapter.fileInput?.() ?? null;
    expect(found).not.toBeNull();
    expect(acceptsFile(found!, "webmcp-c4-notes.csv.md", "text/markdown")).toBe(true);
  });

  it("clicks the trigger, waits for the input, and hands it back", async () => {
    document.body.innerHTML = GEMINI_ZERO_STATE;
    const trigger = geminiAdapter.uploadTrigger!()!;
    // Stand in for the CDK overlay: the menu materialises on click, and the
    // trigger tracks its own open state the way Angular Material's does.
    let clicks = 0;
    trigger.addEventListener("click", () => {
      clicks += 1;
      trigger.setAttribute("aria-expanded", clicks % 2 === 1 ? "true" : "false");
      if (clicks === 1) document.body.insertAdjacentHTML("beforeend", GEMINI_UPLOAD_MENU);
    });

    const input = await revealFileInput(trigger, () => geminiAdapter.fileInput?.() ?? null, FAST);
    expect(input).not.toBeNull();
    expect(clicks).toBe(1);

    // And the menu is put back, so the user is not left with it hanging open
    // over the composer.
    dismissUploader(trigger);
    expect(clicks).toBe(2);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // Clicking again would *reopen* it, so a closed menu is left alone.
    dismissUploader(trigger);
    expect(clicks).toBe(2);
  });

  it("gives up and closes the menu again when no input appears", async () => {
    document.body.innerHTML = GEMINI_ZERO_STATE;
    const trigger = geminiAdapter.uploadTrigger!()!;
    let clicks = 0;
    trigger.addEventListener("click", () => {
      clicks += 1;
      trigger.setAttribute("aria-expanded", clicks === 1 ? "true" : "false");
    });

    expect(await revealFileInput(trigger, () => null, FAST)).toBeNull();
    // Opened, then closed: two clicks, not one left hanging.
    expect(clicks).toBe(2);
  });
});

/**
 * The second element this extension clicks on its own initiative. The first one
 * — the send button — is where a microphone got clicked on a live page, so this
 * guard is written before the equivalent happens here rather than after.
 */
describe("isPlausibleUploadTrigger", () => {
  const el = (attrs: string) => {
    document.body.innerHTML = `<button ${attrs}></button>`;
    return document.querySelector("button")!;
  };

  it.each([
    'aria-label="Upload and tools"',
    'aria-label="Add files or tools"',
    'aria-label="Upload files"',
    'aria-label="Attach file"',
  ])("accepts %s", (attrs) => {
    expect(isPlausibleUploadTrigger(el(attrs))).toBe(true);
  });

  it.each([
    'aria-label="Send message"',
    'aria-label="Submit"',
    'aria-label="Dictate (\u2318\u21e7D)"',
    'aria-label="Use voice mode"',
    'aria-label="Stop generating"',
    'aria-label="Download"',
    // Unlabelled is refused here, unlike the send button: not clicking costs a
    // shortened paste, and clicking the wrong thing costs the user something.
    "",
  ])("refuses %s", (attrs) => {
    expect(isPlausibleUploadTrigger(el(attrs))).toBe(false);
  });

  it("refuses to click a trigger whose label does not look like uploading", async () => {
    const trigger = el('aria-label="Send message"');
    let clicked = false;
    trigger.addEventListener("click", () => {
      clicked = true;
    });
    expect(await revealFileInput(trigger, () => null, FAST)).toBeNull();
    expect(clicked).toBe(false);
  });
});

/**
 * `.md` used to be appended to every attachment, which meant a CSV arrived as
 * `…csv.md` and had to carry a header line the model could not parse. It is now
 * only the escape hatch for a host whose `accept` list does not know the real
 * extension — both lists that exist take `.csv`, `.json` and `.ts`, and neither
 * takes `.zig` or `.log`.
 */
describe("the .md fallback", () => {
  const adapterWith = (accept: string): SiteAdapter => {
    document.body.innerHTML =
      `<div id="composer-area"><div contenteditable="true" id="composer"></div>` +
      `<input type="file" accept="${accept}"></div>`;
    return {
      id: "test",
      conversationRoot: () => document.body,
      assistantTurns: () => [],
      isStreaming: () => false,
      composer: () => document.querySelector<HTMLElement>("#composer"),
      submitButton: () => null,
      fileInput: () => document.querySelector<HTMLInputElement>('input[type="file"]'),
    };
  };

  const confirmOnChange = (marker: string) => {
    document.querySelector("input")!.addEventListener("change", () => {
      const chip = document.createElement("div");
      chip.textContent = marker;
      document.querySelector("#composer-area")!.append(chip);
    });
  };

  beforeEach(() => installFileStubs());
  afterEach(() => removeFileStubs());

  it("is not used when the host takes the real extension", async () => {
    const adapter = adapterWith(".csv,.md,.txt");
    confirmOnChange(ATTACHMENT.marker);
    stubExecCommand();

    const outcome = await insertAndSubmit(adapter, `attached: ${ATTACHMENT.filename}`, ATTACHMENT);
    expect(outcome.status).not.toBe("attach_failed");
    expect((document.querySelector("input")!.files as unknown as File[])[0]!.name).toBe(
      "webmcp-c4-漢検漢字辞典漢字.csv",
    );
  });

  it("appends .md when the host would refuse the real extension", async () => {
    const adapter = adapterWith(".md,.txt");
    confirmOnChange(ATTACHMENT.marker);
    stubExecCommand();

    const composer = document.querySelector<HTMLElement>("#composer")!;
    await insertAndSubmit(adapter, `attached: ${ATTACHMENT.filename}`, ATTACHMENT);

    const file = (document.querySelector("input")!.files as unknown as File[])[0]!;
    expect(file.name).toBe("webmcp-c4-漢検漢字辞典漢字.csv.md");
    // And the covering message is rewritten to match, so it does not name a
    // file that is not the one attached.
    expect(composer.textContent).toContain("webmcp-c4-漢検漢字辞典漢字.csv.md");
  });

  it("gives up when neither name would be accepted", async () => {
    const adapter = adapterWith("image/*");
    const outcome = await insertAndSubmit(adapter, "note", ATTACHMENT);
    expect(outcome.status).toBe("attach_failed");
    expect(outcome.detail).toContain("refuses");
  });
});

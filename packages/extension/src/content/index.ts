import {
  type FencedBlock,
  type PageDiagnostics,
  type PageRequest,
  type PageResponse,
  type ToolDescriptor,
  type WorkerToPageMessage,
  collectFromBlocks,
  hash,
  looksLikeToolCall,
  renderAttachedResult,
  renderPreamble,
  renderToolError,
  renderToolResult,
} from "@webmcp/protocol";
import { adapterForHost } from "./adapters/index.js";
import { type WrappedAdapter, turnsToScan, withFallbacks } from "./adapters/heuristics.js";
import type { ToolResult } from "@webmcp/protocol";
import type { PendingAttachment } from "./attach.js";
import { insertAndSubmit } from "./compose.js";
import { CallGate, MAX_CALL_AGE_MS } from "./gate.js";
import { CallHistory } from "./history.js";
import { blocksFromTurn } from "./serialize.js";

/**
 * The content script. DOM in, DOM out — it holds no socket and no token, and
 * everything it learns from the page it forwards to the service worker as a
 * request, never as an instruction.
 *
 * Assume this file is running inside a hostile document: the tool calls it
 * finds are text a model typed, and any web page the model read could have put
 * them there. That is fine, because being wrong here costs nothing on its own.
 * The daemon re-decides every call.
 */

const DEBOUNCE_MS = 250;
/**
 * A code block whose text has not changed for this long is treated as finished
 * even if the host never told us streaming stopped. Belt to the closing-fence
 * braces: some hosts leave a response element in a streaming-looking state
 * indefinitely after the last token.
 */
const STABLE_MS = 700;
/**
 * Settling window for a block whose closedness was *inferred* from the DOM
 * rather than observed as a terminator.
 *
 * Longer, because it is carrying the whole weight of the guard on its own.
 * A partial JSON does not parse at all; the only thing this has to rule out is
 * a valid-but-incomplete prefix like `{"tool":"fs_write"}` sitting still while
 * `args` is mid-flight — and tokens arrive far faster than this.
 */
const UNCLOSED_STABLE_MS = 2_500;
/** How long to keep retrying a paste while the user is typing in the composer. */
const BUSY_RETRY_MS = 1_500;
const BUSY_RETRY_LIMIT = 20;
/** Safety-net rescan, independent of the mutation observer. */
const POLL_MS = 1_500;
/**
 * How much of an oversized result to paste when its upload failed.
 *
 * Well under the daemon's own paste budget, because arriving here means the
 * result was over that budget in the first place and the whole reason for the
 * upload was that pasting this much text is what wedges the tab. The model is
 * told to page the rest with `offset`.
 */
const FALLBACK_PASTE_CHARS = 16_000;


class Runner {
  /** De-duplication, seeding and freshness. See `gate.ts`. */
  private readonly gate = new CallGate(Date.now());
  /** What earlier sessions in this same conversation already dispatched. */
  private readonly history = new CallHistory(CallHistory.threadKey(location));
  private queue: Promise<void> = Promise.resolve();
  private observer: MutationObserver | undefined;
  private timer: number | undefined;
  private poll: number | undefined;

  private lastError: string | null = null;
  /** Kept only so the diagnostics report can show what the scanner is seeing. */
  private lastBlocks: FencedBlock[] = [];

  constructor(private readonly site: WrappedAdapter) {}

  async attach(): Promise<void> {
    // Before anything is scanned. Starting to scan first would race the load and
    // re-run the very calls this is here to remember.
    this.gate.remember(await this.history.load());

    const root = await this.waitForRoot();
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(root, { childList: true, subtree: true, characterData: true });

    // A mutation observer is not enough on its own here. These pages are SPAs:
    // the node we attached to can be swapped out by a re-render, after which it
    // is detached and fires nothing ever again — indistinguishable, from the
    // outside, from "the model never replied". A slow poll costs a few
    // querySelectorAll calls and removes that entire class of silent failure.
    this.poll = setInterval(() => this.scan(), POLL_MS) as unknown as number;

    this.schedule();
  }

  /** The conversation container appears after hydration on every one of these hosts. */
  private async waitForRoot(): Promise<Element> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const root = this.site.conversationRoot();
      if (root) return root;
      await sleep(500);
    }
    // Fall back to the body rather than giving up: a subtree observer on
    // document.body is wasteful but still correct.
    return document.body;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, DEBOUNCE_MS) as unknown as number;
  }

  private scan(): void {
    if (orphaned) {
      this.detach();
      return;
    }
    const streaming = this.site.isStreaming();

    // Filtered again here, not only in the adapter wrapper: a tool call found
    // inside a user turn is one the model never made — it is the preamble's own
    // example, or a pasted-back result — and running it is a correctness bug no
    // amount of de-duplication fixes.
    // Bounded before the per-turn DOM work, not after. Only the tail can contain
    // a call that has not been handled, and `touchesUserTurn` costs a subtree
    // walk per marker — filtering the whole conversation first made every scan
    // more expensive as the chat grew, which is how an extension makes a chat UI
    // stop keeping up part-way through a session.
    const turns = turnsToScan(this.site.assistantTurns());
    // Anything already on screen is from before this scanner existed: the user
    // reopened a tab, they did not ask for the transcript to be replayed.
    const seeding = this.gate.beginScan(turns.length > 0);

    for (const turn of turns) {
      const { blocks, source } = blocksFromTurn(turn, streaming);
      this.lastBlocks = blocks;

      const { calls, errors } = collectFromBlocks(blocks, {
        // A renderer that relabelled the block must not be able to hide a call.
        acceptMislabelled: true,
        // For DOM-derived blocks, "unclosed" is a guess; the settling check
        // below is the real guard. For text-derived blocks it is an observation,
        // and an unterminated fence is refused outright.
        includeUnclosed: source === "dom",
      });

      const unclosed = new Set(blocks.filter((b) => !b.closed).map((b) => hash(b.body)));

      for (const error of errors) {
        // Settled like a call, and for the same reason: a block still being
        // typed passes through a great many states that are not valid JSON, and
        // answering each of them fills the conversation with complaints about a
        // call the model has not finished writing.
        const verdict = this.gate.admit(`err:${hash(error.raw)}`, error.raw, STABLE_MS, seeding);
        if (verdict === "settling") {
          this.reschedule(STABLE_MS);
          continue;
        }
        if (verdict !== "run") continue;
        this.enqueue(() =>
          this.deliver(
            renderToolError(
              "unknown",
              "webmcp",
              `Your tool call could not be read: ${error.message}. ` +
                "Emit a single JSON object with \"tool\" and \"args\".",
            ),
          ),
        );
      }

      for (const call of calls) {
        const key = `call:${hash(call.raw)}`;
        const settle = unclosed.has(hash(call.raw)) ? UNCLOSED_STABLE_MS : STABLE_MS;

        switch (this.gate.admit(key, call.raw, settle, seeding)) {
          case "run":
            // Recorded at dispatch, not at completion. A call that was sent and
            // then abandoned — the daemon dropped, the tab closed — must not be
            // retried on the next page load; that is the failure this exists
            // for.
            void this.history.record(key);
            this.enqueue(() => this.dispatch(call.id, call.tool, call.args));
            break;
          case "already-run":
            this.report(
              "warn",
              `skipped a ${call.tool} call this extension already ran ` +
                `${ago(this.history.ranAt(key))} — ask again if you want it repeated`,
            );
            break;
          case "settling":
            // Re-scan once the window can actually have elapsed: after the last
            // token there are no more mutations, so nothing else would wake the
            // scanner up again.
            this.reschedule(settle);
            break;
          case "history":
            console.debug(`[webmcp] not running ${call.tool} — it predates this page load`);
            break;
          case "stale":
            // Said out loud. A call silently not running looks identical to a
            // daemon that is not connected, and the user has no way to tell.
            this.report(
              "warn",
              `skipped a ${call.tool} call that sat unrun for more than ` +
                `${Math.round(MAX_CALL_AGE_MS / 1000)}s — ask again if you still want it`,
            );
            break;
          case "duplicate":
            break;
        }
      }
    }
  }

  /**
   * Re-scan once the settling window can actually have elapsed. The debounce
   * alone is not enough: after the last token there are no more mutations, so
   * nothing else would ever wake the scanner up again.
   */
  private reschedule(settleMs: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, Math.min(settleMs, 1_000) + 50) as unknown as number;
  }

  /** One call at a time: the results are pasted into a single shared composer. */
  private enqueue(task: () => Promise<unknown>): void {
    this.queue = this.queue
      .then(task)
      .then(() => undefined)
      .catch((err: unknown) => {
        console.warn("[webmcp]", err);
      });
  }

  private async dispatch(
    callId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    // Asked of the live DOM at call time, not cached at startup: the answer is
    // "does this page have an uploader right now", and these are SPAs. It only
    // tells the daemon whether an oversized result is worth sending whole —
    // the daemon still decides what may be read at all.
    const canAttach = this.site.fileInput() !== null || this.site.uploadTrigger() !== null;
    const reply = await ask({ kind: "page_call_tool", callId, name: tool, args, canAttach });

    if (reply.kind === "page_result") {
      await this.deliverResult(callId, tool, reply.result);
      return;
    }
    const message = reply.kind === "page_error" ? reply.message : "no response from WebMCP";
    await this.deliver(renderToolError(callId, tool, message));
  }

  /**
   * Put a result into the conversation, as an upload when the daemon marked it
   * too large to paste.
   *
   * The fallback is the point. An upload can fail for reasons nothing here can
   * see — the host rejected the type, the user is logged out, the input moved —
   * and every one of them has to end in the model getting *something*, so a
   * failure degrades to the shortened paste that was the only behaviour before
   * uploads existed.
   */
  private async deliverResult(callId: string, tool: string, result: ToolResult): Promise<void> {
    const only = result.content.length === 1 ? result.content[0] : undefined;
    const attach = only?.attach;

    if (only && attach) {
      const bytes = new TextEncoder().encode(only.text).length;
      const sent = await this.deliver(
        renderAttachedResult(callId, tool, attach.filename, bytes, only.truncated === true),
        {
          filename: attach.filename,
          marker: attach.marker,
          mediaType: attach.mediaType,
          body: only.text,
        },
      );
      if (sent) return;
      this.report(
        "warn",
        `could not upload ${attach.filename} (${bytes} bytes) — pasting a shortened result instead`,
      );
      await this.deliver(renderToolResult(callId, tool, shorten(result)));
      return;
    }

    await this.deliver(renderToolResult(callId, tool, result));
  }

  /**
   * Paste a turn back into the conversation. If the user is mid-sentence in the
   * composer we wait rather than overwrite what they typed.
   */
  private async deliver(text: string, attachment?: PendingAttachment): Promise<boolean> {
    for (let attempt = 0; attempt < BUSY_RETRY_LIMIT; attempt++) {
      const outcome = await insertAndSubmit(this.site, text, attachment);
      if (outcome.status === "sent") {
        this.lastError = null;
        return true;
      }
      // "busy" and "streaming" are both "try again shortly", not failures.
      if (outcome.status === "busy" || outcome.status === "streaming") {
        await sleep(BUSY_RETRY_MS);
        continue;
      }
      // Reported by the caller, not here: a failed upload has a fallback, and
      // announcing it as an error before the fallback has run would say the
      // delivery failed when it is about to succeed as a shortened paste.
      if (outcome.status === "attach_failed") {
        console.warn(`[webmcp] ${outcome.detail}`);
        return false;
      }
      this.report("error", `${outcome.status}: ${outcome.detail}`);
      return false;
    }
    this.report("warn", "gave up waiting for the composer to be free");
    return false;
  }

  /** Stop watching. Called once the extension is reloaded out from under us. */
  private detach(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.poll !== undefined) clearInterval(this.poll);
    this.poll = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Say it out loud: silence in the page is the worst failure mode here. */
  private report(level: "warn" | "error", message: string): void {
    this.lastError = message;
    console.warn(`[webmcp] ${message}`);
    if (orphaned) return;
    void chrome.runtime.sendMessage({ kind: "page_report", level, message }).catch(() => {});
  }

  diagnose(): PageDiagnostics {
    const root = this.site.conversationRoot();
    const composer = this.site.composer();
    const submit = this.site.submitButton();
    const fileInput = this.site.fileInput();
    const uploadTrigger = this.site.uploadTrigger();
    const fallbacks = [...this.site.fellBackOn];
    // Force a scan so the block list reflects the page as it is right now
    // rather than whenever the last mutation happened to land.
    this.scan();

    return {
      host: location.host,
      adapter: fallbacks.length ? `${this.site.id} (guessing: ${fallbacks.join(", ")})` : this.site.id,
      conversationRoot: root !== null,
      assistantTurns: this.site.assistantTurns().length,
      composer: composer ? describe(composer) : null,
      submitButton: submit ? describe(submit) : null,
      fileInput: fileInput
        ? describe(fileInput)
        : uploadTrigger
          ? `behind ${describe(uploadTrigger)}`
          : null,
      streaming: this.site.isStreaming(),
      codeBlocks: document.querySelectorAll("main pre, pre").length,
      skippedCalls: this.gate.skipped,
      blocks: this.lastBlocks.map((b) => ({
        tag: b.tag,
        closed: b.closed,
        looksLikeCall: looksLikeToolCall(b.body),
        preview: b.body.trim().slice(0, 60),
      })),
      lastError: this.lastError,
    };
  }

  async injectPreamble(): Promise<void> {
    const status = await ask({ kind: "page_status" });
    const tools = await ask({ kind: "page_list_tools" });
    if (tools.kind !== "page_tools") {
      const why = tools.kind === "page_error" ? tools.message : "no tool list";
      this.report("error", `cannot inject preamble: ${why}`);
      return;
    }
    const workspace =
      status.kind === "page_status_reply" && status.workspace ? status.workspace : "the workspace";
    const preamble = renderPreamble(tools.tools as ToolDescriptor[], workspace);
    this.enqueue(() => this.deliver(preamble));
  }
}

/**
 * Chrome's wording for "this content script is now an orphan".
 *
 * It happens whenever the extension is reloaded or updated while a chat page is
 * open: the old content script keeps running, but every `chrome.runtime` call
 * throws. The script cannot recover — only a page reload can — so this is worth
 * recognising rather than passing along.
 */
const ORPHANED = /Extension context invalidated|Receiving end does not exist|message port closed/i;

/** True once the extension has been reloaded out from under this script. */
let orphaned = false;

/** Ask the service worker. Errors come back as data, never as a throw. */
async function ask(request: PageRequest): Promise<PageResponse> {
  if (orphaned) {
    return { kind: "page_error", message: ORPHANED_MESSAGE };
  }
  try {
    const reply = (await chrome.runtime.sendMessage(request)) as PageResponse | undefined;
    return reply ?? { kind: "page_error", message: "WebMCP background is not responding" };
  } catch (err) {
    const message = (err as Error).message;
    if (ORPHANED.test(message)) {
      // Raw Chrome wording — "Extension context invalidated." — used to be
      // pasted into the conversation verbatim as a tool error. It tells the
      // model nothing and the user less. Replace it with the one thing that
      // actually fixes it, and stop scanning: nothing this script does from here
      // can succeed.
      orphaned = true;
      console.warn(`[webmcp] ${ORPHANED_MESSAGE}`);
      return { kind: "page_error", message: ORPHANED_MESSAGE };
    }
    return { kind: "page_error", message };
  }
}

const ORPHANED_MESSAGE =
  "WebMCP lost its connection because the extension was reloaded. " +
  "Reload this page, then ask again.";

/** Compact element description for the diagnostics report. */
function describe(el: Element): string {
  const rect = el.getBoundingClientRect();
  const bits = [`<${el.tagName.toLowerCase()}>`];
  for (const attr of ["id", "data-testid", "aria-label", "placeholder"]) {
    const value = el.getAttribute(attr);
    if (value) bits.push(`${attr}=${JSON.stringify(value.slice(0, 40))}`);
  }
  bits.push(`${Math.round(rect.width)}x${Math.round(rect.height)}`);
  return bits.join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long ago, in words. Exists because "30 seconds ago" and "two days ago"
 * are the difference between a call worth retrying and one that has already
 * been answered further down the conversation — and the page itself cannot tell
 * anyone which it is.
 */
function ago(at: number | null): string {
  if (at === null) return "earlier";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Cut an oversized result down to something safe to paste.
 *
 * Only ever reached when an upload failed, so it is the second-best answer by
 * construction — but it has to name the shortfall, because a result that is
 * quietly missing most of a file reads to the model as a complete one.
 */
function shorten(result: ToolResult): ToolResult {
  return {
    ...result,
    content: result.content.map((part) => {
      if (part.text.length <= FALLBACK_PASTE_CHARS) return part;
      return {
        ...part,
        attach: undefined,
        truncated: true,
        text:
          part.text.slice(0, FALLBACK_PASTE_CHARS) +
          `\n\n[webmcp: the full result could not be uploaded, so this shows the first ` +
          `${FALLBACK_PASTE_CHARS} of ${part.text.length} characters. ` +
          `Page through the rest with the tool's offset argument.]`,
      };
    }),
  };
}

const site = adapterForHost(location.host);
const runner = site ? new Runner(withFallbacks(site)) : null;

/**
 * Registered unconditionally, at module scope, before anything can go wrong.
 *
 * Two failure modes were previously indistinguishable from here: a host no
 * adapter claims, and a content script that never loaded. Both showed up in the
 * popup as "no content script in that tab", which points the user at reloading
 * a page that was never the problem. Answering always means the popup can say
 * which it is.
 */
chrome.runtime.onMessage.addListener((message: WorkerToPageMessage, _sender, sendResponse) => {
  if (message?.kind === "diagnose") {
    sendResponse(runner ? runner.diagnose() : emptyDiagnostics());
    return false;
  }
  if (message?.kind === "inject_preamble") {
    if (!runner) {
      sendResponse({ ok: false, error: `no WebMCP adapter for ${location.host}` });
      return false;
    }
    void runner.injectPreamble();
    sendResponse({ ok: true });
    return false;
  }
  sendResponse({ ok: false });
  return false;
});

console.debug(
  `[webmcp] content script active on ${location.host}` +
    (site ? ` — adapter: ${site.id}` : " — no adapter claims this host"),
);

if (runner) void runner.attach();

function emptyDiagnostics(): PageDiagnostics {
  return {
    host: location.host,
    adapter: null,
    conversationRoot: false,
    assistantTurns: 0,
    composer: null,
    submitButton: null,
    fileInput: null,
    streaming: false,
    codeBlocks: document.querySelectorAll("pre").length,
    skippedCalls: 0,
    blocks: [],
    lastError: `no WebMCP adapter claims ${location.host}`,
  };
}

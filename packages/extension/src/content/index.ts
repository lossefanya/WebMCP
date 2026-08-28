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
  renderPreamble,
  renderToolError,
  renderToolResult,
} from "@webmcp/protocol";
import { adapterForHost } from "./adapters/index.js";
import { type WrappedAdapter, turnsToScan, withFallbacks } from "./adapters/heuristics.js";
import { insertAndSubmit } from "./compose.js";
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


class Runner {
  /** Blocks already dispatched, so a re-render is not a second execution. */
  private readonly handled = new Set<string>();
  /** Block key -> {text, firstSeen}, for the stability check. */
  private readonly seen = new Map<string, { text: string; at: number }>();
  private queue: Promise<void> = Promise.resolve();
  private observer: MutationObserver | undefined;
  private timer: number | undefined;
  private poll: number | undefined;

  private lastError: string | null = null;
  /** Kept only so the diagnostics report can show what the scanner is seeing. */
  private lastBlocks: FencedBlock[] = [];

  constructor(private readonly site: WrappedAdapter) {}

  async attach(): Promise<void> {
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
    for (const turn of turnsToScan(this.site.assistantTurns())) {
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

      const unclosed = new Set(
        blocks.filter((b) => !b.closed).map((b) => `call:${hash(b.body)}`),
      );

      for (const error of errors) {
        const key = `err:${hash(error.raw)}`;
        if (this.handled.has(key)) continue;
        this.handled.add(key);
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
        if (this.handled.has(key)) continue;
        const settle = unclosed.has(key) ? UNCLOSED_STABLE_MS : STABLE_MS;
        if (!this.isStable(key, call.raw, settle)) continue;
        this.handled.add(key);
        this.enqueue(() => this.dispatch(call.id, call.tool, call.args));
      }
    }
  }

  /**
   * Second guard behind the closing fence. A JSON object can be *valid* while
   * still incomplete — `{"tool":"fs_write"}` parses fine before `args` arrives —
   * so a block also has to stop changing before it is allowed to run.
   */
  private isStable(key: string, text: string, settleMs: number): boolean {
    const now = Date.now();
    const previous = this.seen.get(key);
    if (!previous || previous.text !== text) {
      this.seen.set(key, { text, at: now });
      this.reschedule(settleMs);
      return false;
    }
    if (now - previous.at < settleMs) {
      this.reschedule(settleMs);
      return false;
    }
    return true;
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
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      console.warn("[webmcp]", err);
    });
  }

  private async dispatch(
    callId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const reply = await ask({ kind: "page_call_tool", callId, name: tool, args });

    if (reply.kind === "page_result") {
      await this.deliver(renderToolResult(callId, tool, reply.result));
      return;
    }
    const message = reply.kind === "page_error" ? reply.message : "no response from WebMCP";
    await this.deliver(renderToolError(callId, tool, message));
  }

  /**
   * Paste a turn back into the conversation. If the user is mid-sentence in the
   * composer we wait rather than overwrite what they typed.
   */
  private async deliver(text: string): Promise<void> {
    for (let attempt = 0; attempt < BUSY_RETRY_LIMIT; attempt++) {
      const outcome = await insertAndSubmit(this.site, text);
      if (outcome.status === "sent") {
        this.lastError = null;
        return;
      }
      // "busy" and "streaming" are both "try again shortly", not failures.
      if (outcome.status === "busy" || outcome.status === "streaming") {
        await sleep(BUSY_RETRY_MS);
        continue;
      }
      this.report("error", `${outcome.status}: ${outcome.detail}`);
      return;
    }
    this.report("warn", "gave up waiting for the composer to be free");
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
      streaming: this.site.isStreaming(),
      codeBlocks: document.querySelectorAll("main pre, pre").length,
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
    streaming: false,
    codeBlocks: document.querySelectorAll("pre").length,
    blocks: [],
    lastError: `no WebMCP adapter claims ${location.host}`,
  };
}

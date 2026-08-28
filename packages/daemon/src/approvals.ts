import { randomBytes } from "node:crypto";
import type { ApprovalRequestMessage, ToolDescriptor } from "@webmcp/protocol";
import type { Logger } from "./log.js";
import { truncate } from "./text.js";

export type ApprovalOutcome = "allow_once" | "allow_always" | "deny";

interface Pending {
  nonce: string;
  callId: string;
  settle(outcome: ApprovalOutcome): void;
  timer: NodeJS.Timeout;
}

/**
 * Human-in-the-loop for state-changing calls.
 *
 * The asymmetry that matters: the daemon mints the nonce, remembers it, and
 * accepts exactly one answer for it before a deadline. The extension renders
 * the prompt and relays a click. It cannot invent a nonce, cannot reuse one,
 * and cannot answer a call it was not asked about — so a page that somehow got
 * a message onto this channel still cannot self-approve.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {}

  /**
   * Build the prompt, hand it to `send`, and resolve when a human answers.
   * Silence is a denial, never an approval.
   */
  request(opts: {
    callId: string;
    descriptor: ToolDescriptor;
    args: Record<string, unknown>;
    origin: string;
    summary: string;
    alwaysLabel: string | undefined;
    /** Aborting the call — a client `cancel`, or a dropped socket — denies it. */
    signal?: AbortSignal;
    send(message: ApprovalRequestMessage): void;
  }): Promise<ApprovalOutcome> {
    const nonce = randomBytes(18).toString("base64url");

    return new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: ApprovalOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(nonce);
        resolve(outcome);
      };

      const onAbort = () => {
        this.log.audit(`approval cancelled — denied ${opts.descriptor.name} (${opts.callId})`);
        settle("deny");
      };

      const timer = setTimeout(() => {
        this.log.audit(`approval timeout — denied ${opts.descriptor.name} (${opts.callId})`);
        settle("deny");
      }, this.timeoutMs);
      timer.unref?.();

      if (opts.signal?.aborted) {
        settle("deny");
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(nonce, { nonce, callId: opts.callId, settle, timer });

      const message: ApprovalRequestMessage = {
        kind: "approval_request",
        nonce,
        callId: opts.callId,
        tool: opts.descriptor.name,
        risk: opts.descriptor.risk,
        origin: opts.origin,
        summary: opts.summary,
        detail: renderArgs(opts.args),
        expiresAt: Date.now() + this.timeoutMs,
        ...(opts.alwaysLabel === undefined ? {} : { allowAlwaysLabel: opts.alwaysLabel }),
      };

      try {
        opts.send(message);
      } catch (err) {
        this.log.warn(`approval could not be delivered: ${(err as Error).message}`);
        settle("deny");
      }
    });
  }

  /** Returns false for an unknown, already-used or expired nonce. */
  resolve(nonce: unknown, decision: ApprovalOutcome): boolean {
    if (typeof nonce !== "string") return false;
    const entry = this.pending.get(nonce);
    if (!entry) return false;
    entry.settle(decision);
    return true;
  }

  /** A dropped connection means nobody is looking at the prompt any more. */
  denyAll(reason: string): void {
    for (const entry of [...this.pending.values()]) {
      this.log.audit(`approval abandoned (${reason}) — denied ${entry.callId}`);
      entry.settle("deny");
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * What the human actually reads. Arguments come from a page that may have been
 * prompt-injected, so this is rendered as inert, length-capped text — never
 * interpolated into markup anywhere downstream.
 */
function renderArgs(args: Record<string, unknown>): string {
  let body: string;
  try {
    body = JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    body = "[arguments could not be displayed]";
  }
  return truncate(body, 4_000).text;
}

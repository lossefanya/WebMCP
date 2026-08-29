import type { ToolDescriptor, ToolResult, ToolRisk } from "@webmcp/protocol";
import type { Config } from "../config.js";
import type { Workspace } from "../jail.js";

/** Everything a built-in tool is allowed to reach. Notably: no socket, no config writes. */
export interface ToolContext {
  readonly workspace: Workspace;
  readonly config: Config;
  /** Host page the call came from, for audit lines. */
  readonly origin: string;
  readonly signal: AbortSignal;
  /**
   * How many bytes of text this result may carry before it is cut short.
   *
   * Per-call rather than read from `config.limits`, because the answer depends
   * on the caller: a page that can upload the result as a file has no reason
   * to be held to the paste budget, and one that cannot must be. Tools that
   * truncate read it from here so there is a single place the two budgets meet.
   */
  readonly maxResultBytes: number;
  /**
   * The caller can upload this result as a file rather than paste it.
   *
   * A tool that frames its output for a chat message — `fs_read` prefixes the
   * path and size — should hand back the bare content instead when this is set,
   * because the framing is repeated in the covering message and a header line
   * inside the *file* is corruption: a CSV gains a bogus first row and a JSON
   * file stops parsing.
   */
  readonly canAttach: boolean;
}

/** The subset of context available before approval — no signal, nothing runs yet. */
export interface ValidateContext {
  readonly workspace: Workspace;
  readonly config: Config;
}

export interface Tool {
  readonly descriptor: ToolDescriptor;
  /**
   * A one-line rendering of what this call will do, shown in the approval
   * prompt. Built here because only the tool knows which argument matters.
   */
  summarize(args: Record<string, unknown>): string;
  /**
   * Reject a call before a human is asked about it. Anything knowable without
   * side effects belongs here: an argument that is the wrong type, a binary
   * that is not on the allowlist. Prompting first and refusing afterwards
   * teaches the user that approving is harmless, which is the opposite of what
   * the prompt is for.
   */
  validate?(args: Record<string, unknown>, ctx: ValidateContext): void;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string = "bad_request",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function text(body: string, extra: Partial<{ truncated: boolean; originalBytes: number }> = {}): ToolResult {
  return { content: [{ type: "text", text: body, ...extra }], isError: false };
}

export function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/* Argument coercion. Arguments arrive as text the model typed, so every one of
 * these is a validation boundary, not a convenience. */

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolError(`argument "${key}" must be a non-empty string`);
  }
  return v;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`argument "${key}" must be a string`);
  return v;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolError(`argument "${key}" must be a number`);
  }
  return v;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`argument "${key}" must be a boolean`);
  return v;
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ToolError(`argument "${key}" must be an array of strings`);
  }
  return v as string[];
}

export function riskOf(descriptor: ToolDescriptor): ToolRisk {
  return descriptor.risk;
}

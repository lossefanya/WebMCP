/**
 * Tool descriptions as they cross the wire and as they are rendered into the
 * preamble the model reads. Deliberately a subset of MCP's tool shape: the
 * daemon is the only thing that talks real MCP.
 */

export const NAMESPACE_SEPARATOR = "__";

/** Risk tier. Drives whether the daemon demands human approval before running. */
export type ToolRisk = "read" | "write" | "exec" | "network";

export interface ToolDescriptor {
  /** Namespaced, globally unique: `fs_read`, `notion__search`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: JsonSchema;
  risk: ToolRisk;
  /** `null` for built-ins; the downstream server id for proxied tools. */
  server: string | null;
}

/** Structural stand-in for JSON Schema — we never introspect beyond `type`. */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolResultContent {
  type: "text";
  text: string;
  /** Set when the daemon shortened `text` to keep the chat context small. */
  truncated?: boolean;
  /** Original byte length before truncation. */
  originalBytes?: number;
  /**
   * Deliver this body as an uploaded file rather than as pasted text.
   *
   * Set by the daemon, and only for a caller that said it could attach one
   * (`CallToolMessage.canAttach`). Typing tens of thousands of characters into
   * a rich-text composer is what freezes the tab — every one of these hosts
   * reconciles a node per line — so past a threshold the same bytes go up the
   * host's own file-upload path instead.
   *
   * It is a *delivery* instruction and nothing more: the daemon has already
   * decided this body may leave, under the same jail and the same approval as
   * any other result. The extension may still decline it and fall back to a
   * truncated paste, which is exactly the behaviour that existed before.
   */
  attach?: Attachment;
}

export interface Attachment {
  /**
   * Chosen by the daemon, and built around the *source* — `fs_read` of
   * `notes.csv` attaches `webmcp-c2-notes.csv.md`.
   *
   * The original name is load-bearing, not cosmetic: it is the only thing in
   * the turn that tells the model, and the user, which file the attachment is.
   * The first version named results `webmcp-fs_read-c2.md` and a user reading a
   * CSV had no way to tell what had been attached.
   *
   * The `.md` stays on the end regardless of what the source was. The body is a
   * result *document* — it carries the daemon's own header line — so calling it
   * `.csv` would be a lie, and `.md` is the one extension every host's `accept`
   * list takes.
   */
  filename: string;
  mediaType: string;
  /**
   * A short unique token inside `filename`, and the thing the extension looks
   * for in the page to confirm the upload landed.
   *
   * Separate from the filename because the two want opposite things. The
   * filename wants the source name, which can be long and non-ASCII; the
   * confirmation wants something short enough to survive a chip that truncates,
   * and distinctive enough that it cannot already appear in the conversation —
   * and the conversation is *very* likely to contain the source filename,
   * because the user just asked for it by name. Matching on that would confirm
   * an upload that never happened.
   */
  marker: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError: boolean;
}

/**
 * Splits `notion__search` into `["notion", "search"]`, or returns a null
 * server for an un-namespaced built-in. Only the first separator counts, so a
 * downstream tool may itself contain `__`.
 */
export function splitToolName(name: string): { server: string | null; tool: string } {
  const at = name.indexOf(NAMESPACE_SEPARATOR);
  if (at <= 0) return { server: null, tool: name };
  return {
    server: name.slice(0, at),
    tool: name.slice(at + NAMESPACE_SEPARATOR.length),
  };
}

export function namespaceToolName(server: string, tool: string): string {
  return `${server}${NAMESPACE_SEPARATOR}${tool}`;
}

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

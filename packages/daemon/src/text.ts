/**
 * Tool output is pasted back into the visible conversation, so it is also
 * context the model pays for. Everything that leaves the daemon goes through
 * here first.
 */
export interface Truncation {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

function notice(shown: string, total: number): string {
  return `${shown}\n\n[webmcp: truncated — showed ${Buffer.byteLength(shown, "utf8")} of ${total} bytes]`;
}

/** Cut `body` to at most `maxBytes` of UTF-8, never mid-code-point. */
export function sliceBytes(body: string, maxBytes: number): string {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= maxBytes) return body;
  let shown = buf.subarray(0, maxBytes).toString("utf8");
  // A partial code point decodes to U+FFFD; drop it rather than emit a mojibake.
  if (shown.endsWith("�")) shown = shown.slice(0, -1);
  return shown;
}

export function truncate(body: string, maxBytes: number): Truncation {
  const originalBytes = Buffer.byteLength(body, "utf8");
  if (originalBytes <= maxBytes) return { text: body, truncated: false, originalBytes };
  return { text: notice(sliceBytes(body, maxBytes), originalBytes), truncated: true, originalBytes };
}

/**
 * Line-oriented variant, so a truncated file read still ends on a line break —
 * a half-line of source reads as a syntax error to the model.
 */
export function truncateLines(body: string, maxBytes: number): Truncation {
  const originalBytes = Buffer.byteLength(body, "utf8");
  if (originalBytes <= maxBytes) return { text: body, truncated: false, originalBytes };

  const raw = sliceBytes(body, maxBytes);
  const lastBreak = raw.lastIndexOf("\n");
  // Only honour the line boundary if it doesn't throw away most of the budget.
  const shown = lastBreak > raw.length / 2 ? raw.slice(0, lastBreak + 1) : raw;
  return { text: notice(shown, originalBytes), truncated: true, originalBytes };
}

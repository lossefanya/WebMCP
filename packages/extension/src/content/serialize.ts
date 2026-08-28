import { type FencedBlock, extractFencedBlocks } from "@webmcp/protocol";

export interface TurnBlocks {
  blocks: FencedBlock[];
  /**
   * Where closedness came from.
   *
   * `"text"` means a literal terminator was seen, or genuinely was not — that
   * is an observation, and an unclosed block really is still being typed.
   *
   * `"dom"` means it was *inferred* from "the renderer already created a
   * `<pre>`", which is a guess. A caller must not treat an inferred-unclosed
   * block as a hard refusal, or a host that leaves its response element looking
   * permanently mid-stream will deadlock every call.
   */
  source: "dom" | "text";
}

/**
 * Recover fenced blocks from a rendered assistant turn.
 *
 * By the time markdown has been rendered the backticks are gone — the block is
 * a `<pre><code>` element — so closedness cannot be read off the text any more.
 * It has to be inferred, and the inference is deliberately pessimistic: while
 * the turn is streaming, the *last* code block in it is assumed to still be
 * growing. Everything earlier is finished, because the renderer only closes a
 * block once it has seen the terminator.
 */
export function blocksFromTurn(turn: Element, streaming: boolean): TurnBlocks {
  const codes = [...turn.querySelectorAll("pre code, pre")];
  // `pre code` and `pre` both matched for the same block: keep the inner one.
  const unique = codes.filter((el) => !(el.tagName === "PRE" && el.querySelector("code")));

  if (unique.length === 0) {
    // Nothing rendered as a code block. Some hosts show raw text first, and a
    // model occasionally emits the fence outside a code block; the literal
    // scanner handles both and gets closedness for free.
    return { blocks: extractFencedBlocks(turn.textContent ?? ""), source: "text" };
  }

  return {
    source: "dom",
    blocks: unique.map((el, index) => ({
      tag: languageOf(el),
      body: el.textContent ?? "",
      closed: !(streaming && index === unique.length - 1),
    })),
  };
}

/**
 * The info string, wherever this host stashed it — and `null` when it is simply
 * not recoverable.
 *
 * No shape-sniffing here on purpose. A wrong label used to be able to veto a
 * valid call: a highlighter deciding a `webmcp` block was really `json` made
 * the block invisible. Deciding what an unlabelled or mislabelled block is
 * belongs to `collectFromBlocks`, which has the actual parser and is unit
 * tested; this function's only job is to report what the DOM says.
 */
function languageOf(el: Element): string | null {
  const fromClass = /(?:^|\s)(?:language|lang)-([\w-]+)/i.exec(el.className || "");
  if (fromClass?.[1]) return fromClass[1].toLowerCase();

  const attr =
    el.getAttribute("data-language") ??
    el.getAttribute("data-lang") ??
    el.closest("pre")?.getAttribute("data-language");

  return attr ? attr.toLowerCase() : null;
}

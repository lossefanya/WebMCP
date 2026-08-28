import { describe, expect, it } from "vitest";
import { truncate, truncateLines } from "../src/text.js";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hello", 100)).toEqual({ text: "hello", truncated: false, originalBytes: 5 });
  });

  it("cuts long text and says how much it dropped", () => {
    const cut = truncate("x".repeat(1_000), 100);
    expect(cut.truncated).toBe(true);
    expect(cut.originalBytes).toBe(1_000);
    expect(cut.text).toContain("showed 100 of 1000 bytes");
  });

  it("measures bytes, not characters", () => {
    // Four-byte code points: 10 characters is 40 bytes.
    const emoji = "🙂".repeat(10);
    expect(truncate(emoji, 100).truncated).toBe(false);
    expect(truncate(emoji, 20).truncated).toBe(true);
  });

  it("never cuts a code point in half", () => {
    // A 21-byte budget lands mid-emoji; the partial one must be dropped whole.
    const cut = truncate("🙂".repeat(10), 21);
    expect(cut.text).not.toContain("�");
    const shown = cut.text.split("\n\n[webmcp")[0] ?? "";
    expect(Buffer.byteLength(shown, "utf8") % 4).toBe(0);
  });
});

describe("truncateLines", () => {
  it("prefers a line boundary", () => {
    const body = `${"abcd\n".repeat(20)}`;
    const cut = truncateLines(body, 22);
    const shown = cut.text.split("\n\n[webmcp")[0] ?? "";
    expect(shown.endsWith("\n")).toBe(true);
    expect(shown).toBe("abcd\nabcd\nabcd\nabcd\n");
  });

  it("falls back to a hard cut when the line boundary would waste the budget", () => {
    // One enormous line: honouring the boundary would show almost nothing.
    const cut = truncateLines(`short\n${"y".repeat(500)}`, 100);
    const shown = cut.text.split("\n\n[webmcp")[0] ?? "";
    expect(shown.length).toBeGreaterThan(50);
  });
});

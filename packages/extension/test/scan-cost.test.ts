import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCAN_DEPTH, SCAN_WINDOW, turnsToScan } from "../src/content/adapters/heuristics.js";

/**
 * A scan runs on every mutation and on a poll, and every tool result pastes a
 * new turn into the page. So the per-scan cost must not grow with the length of
 * the conversation — otherwise a session that reads many files gets slower with
 * every file it reads, and the tab stops keeping up part-way through. That was
 * the reported symptom: Chrome going unresponsive during a long run of reads.
 *
 * `touchesUserTurn` is the expensive part — a subtree `querySelector` per marker
 * per turn — and it used to run over every turn in the conversation before the
 * tail was taken. These tests measure the cost rather than trusting the comment
 * that says it is bounded.
 */
function conversation(turnCount: number): Element[] {
  document.body.innerHTML = "";
  const turns: Element[] = [];
  for (let i = 0; i < turnCount; i++) {
    const turn = document.createElement("div");
    turn.setAttribute("data-perf-row", "assistant");
    // Real turns hold content, which is what makes a subtree walk cost anything.
    turn.innerHTML = `<p>reply ${i}</p><pre><code>some output ${i}</code></pre>`;
    document.body.append(turn);
    turns.push(turn);
  }
  return turns;
}

/**
 * Subtree walks performed by one call, measured from a clean spy.
 *
 * The spy is installed and restored per measurement on purpose: `vi.spyOn`
 * stacks, so a spy left in place by an earlier test wraps the next one's and
 * quietly inflates its count. That produced an off-by-one here that looked like
 * a real cost difference and was not.
 */
function walksDuring(run: () => void): number {
  const real = Element.prototype.querySelector;
  let walks = 0;
  const spy = vi
    .spyOn(Element.prototype, "querySelector")
    .mockImplementation(function (this: Element, selector: string) {
      walks++;
      return real.call(this, selector);
    });
  try {
    run();
    return walks;
  } finally {
    spy.mockRestore();
  }
}

describe("scan cost", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("costs the same at 500 turns as at 5000", () => {
    // Both are longer than the window, so both must examine exactly the window.
    // Before the fix this grew without bound, and every pasted result made the
    // next scan worse — the cost of a session compounding with its own output.
    // Measured while attached, one at a time: `conversation` clears the body, so
    // building both up front would leave the first set detached and walking a
    // detached subtree costs something different.
    const fiveHundred = conversation(500);
    const shortRun = walksDuring(() => void turnsToScan(fiveHundred));

    const fiveThousand = conversation(5_000);
    const longRun = walksDuring(() => void turnsToScan(fiveThousand));

    expect(shortRun).toBeGreaterThan(0);
    // Constant, not equal: jsdom varies by a single call between the first and
    // second measurement in a process, which is an artifact of the harness and
    // not of the code. A difference of ~1 across 4,500 extra turns is the O(1)
    // claim; before the fix this was one subtree walk per marker per turn, so
    // the long run would have been hundreds of times the short one.
    expect(Math.abs(longRun - shortRun)).toBeLessThanOrEqual(2);
    // And bounded in absolute terms, with conversation length nowhere in it.
    expect(longRun).toBeLessThan(SCAN_WINDOW * 20);
  });

  it("scales with the window, not with the conversation", () => {
    const turns = conversation(500);
    const narrow = walksDuring(() => void turnsToScan(turns, SCAN_DEPTH, 4));
    const wide = walksDuring(() => void turnsToScan(turns, SCAN_DEPTH, 8));
    expect(wide).toBe(narrow * 2);
  });

  it("examines no more turns than the window, however long the chat", () => {
    const turns = conversation(1_000);
    const spy = vi.spyOn(Element.prototype, "matches");
    turnsToScan(turns);
    // `matches` runs once per marker per examined turn; count distinct turns.
    expect(new Set(spy.mock.instances).size).toBeLessThanOrEqual(SCAN_WINDOW);
  });

  it("still reads the last turns, and still skips user turns among them", () => {
    const turns = conversation(20);
    // A user turn in the tail must not be scanned: it carries the preamble's
    // worked example and every result pasted back into the conversation.
    turns[19]!.setAttribute("data-perf-row", "human");

    const scanned = turnsToScan(turns);
    expect(scanned).toHaveLength(SCAN_DEPTH);
    expect(scanned).not.toContain(turns[19]);
    expect(scanned).toContain(turns[18]);
  });

  it("returns nothing rather than widening when the window is all user turns", () => {
    // Failing closed: scanning a user turn executes a call nobody made.
    const turns = conversation(30);
    for (const turn of turns.slice(-SCAN_WINDOW)) turn.setAttribute("data-perf-row", "human");
    expect(turnsToScan(turns)).toEqual([]);
  });
});

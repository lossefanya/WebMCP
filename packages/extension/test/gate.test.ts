import { describe, expect, it } from "vitest";
import { CallGate, MAX_CALL_AGE_MS, SEED_WINDOW_MS } from "../src/content/gate.js";

/**
 * A fake clock, because every rule here is about time and a test that sleeps
 * for thirty seconds is a test nobody runs.
 */
function at(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    start,
  };
}

const SETTLE = 700;
const CALL = '{"id":"1","tool":"fs_read","args":{"path":"a.txt"}}';

/** Admit a block that has already settled, as the scanner would after polling. */
function settled(gate: CallGate, clock: ReturnType<typeof at>, raw = CALL, key = "call:a") {
  gate.admit(key, raw, SETTLE, false);
  clock.advance(SETTLE + 1);
  return gate.admit(key, raw, SETTLE, false);
}

describe("CallGate — the conversation that was already there", () => {
  /**
   * The bug this exists for, reported from a live session: something aborted
   * mid-call, and reopening the chat later made the daemon run the command
   * again. A page reload, an extension reload or a crashed content script all
   * empty the de-duplication set, and the next scan sees a transcript full of
   * valid tool calls.
   */
  it("never runs a call that was on screen when it attached", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);

    const seeding = gate.beginScan(true);
    expect(seeding).toBe(true);
    expect(gate.admit("call:a", CALL, SETTLE, seeding)).toBe("history");
    expect(gate.skipped).toBe(1);
  });

  it("keeps it written off on every later scan, however long the tab stays open", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    gate.admit("call:a", CALL, SETTLE, gate.beginScan(true));

    clock.advance(60_000);
    expect(gate.admit("call:a", CALL, SETTLE, gate.beginScan(true))).toBe("duplicate");
  });

  it("runs a call that arrives after the seed window", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    gate.beginScan(true);

    clock.advance(SEED_WINDOW_MS + 1);
    expect(settled(gate, clock)).toBe("run");
  });

  /**
   * The window is not a single first scan because these are SPAs: the first
   * scan can land before the turns have hydrated. Seeding an empty conversation
   * would seed nothing and protect nothing, so it stays armed until there is
   * something to write off.
   */
  it("stays armed while the conversation has not rendered yet", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);

    expect(gate.beginScan(false)).toBe(true);
    clock.advance(300);
    const seeding = gate.beginScan(true);
    expect(seeding).toBe(true);
    expect(gate.admit("call:a", CALL, SETTLE, seeding)).toBe("history");
  });

  /**
   * ...but it must disarm on its own, or a brand-new chat — where nothing is on
   * screen because nothing has been said yet — would swallow the first real
   * call the model makes.
   */
  it("disarms once the window closes, even if nothing ever rendered", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    gate.beginScan(false);

    clock.advance(SEED_WINDOW_MS + 1);
    expect(gate.beginScan(false)).toBe(false);
    expect(settled(gate, clock)).toBe("run");
  });

  /**
   * Parse errors go through the same gate as calls, so a malformed block left
   * over from a previous session is not answered with a complaint the moment
   * the tab is reopened.
   */
  it("does not answer a malformed block left over from a previous session", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    expect(gate.admit("err:a", "{bad", SETTLE, gate.beginScan(true))).toBe("history");

    clock.advance(SEED_WINDOW_MS + 1);
    expect(settled(gate, clock, "{bad", "err:b")).toBe("run");
  });
});

describe("CallGate — freshness", () => {
  it("holds a block until it has stopped changing", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    clock.advance(SEED_WINDOW_MS + 1);
    gate.beginScan(true);

    expect(gate.admit("call:a", '{"tool":"fs_', SETTLE, false)).toBe("settling");
    clock.advance(100);
    // Still growing: the clock restarts, so the settle window has not elapsed.
    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("settling");
    clock.advance(SETTLE - 1);
    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("settling");
    clock.advance(2);
    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("run");
  });

  /**
   * A call that streamed slowly is not stale — the clock measures from the
   * block's last *edit*, not from when it first appeared. Getting this backwards
   * would drop long tool calls, which are exactly the ones worth running.
   */
  it("does not call a slowly-streamed call stale", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    clock.advance(SEED_WINDOW_MS + 1);
    gate.beginScan(true);

    for (let i = 0; i < 20; i++) {
      gate.admit("call:a", `${CALL.slice(0, 10)}${"x".repeat(i)}`, SETTLE, false);
      clock.advance(5_000);
    }
    expect(settled(gate, clock)).toBe("run");
  });

  it("refuses one that finished long ago and was never run", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    clock.advance(SEED_WINDOW_MS + 1);
    gate.beginScan(true);

    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("settling");
    // The tab was backgrounded, or a scan was blocked: the block has not changed
    // in far longer than the settle window.
    clock.advance(MAX_CALL_AGE_MS + 1);
    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("stale");
    expect(gate.skipped).toBe(1);
    // And it is not reconsidered on the next scan.
    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("duplicate");
  });

  it("runs one that has been waiting just under the limit", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    clock.advance(SEED_WINDOW_MS + 1);
    gate.beginScan(true);

    gate.admit("call:a", CALL, SETTLE, false);
    clock.advance(MAX_CALL_AGE_MS - 1);
    expect(gate.admit("call:a", CALL, SETTLE, false)).toBe("run");
  });

  it("runs each distinct call once and only once", () => {
    const clock = at();
    const gate = new CallGate(clock.start, clock.now);
    clock.advance(SEED_WINDOW_MS + 1);
    gate.beginScan(true);

    expect(settled(gate, clock, CALL, "call:a")).toBe("run");
    expect(settled(gate, clock, CALL, "call:a")).toBe("duplicate");
    expect(settled(gate, clock, `${CALL} `, "call:b")).toBe("run");
  });
});

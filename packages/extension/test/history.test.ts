import { describe, expect, it } from "vitest";
import { CallHistory, type StorageArea } from "../src/content/history.js";
import { CallGate, REPLAY_WINDOW_MS, SEED_WINDOW_MS } from "../src/content/gate.js";

/** `chrome.storage.local` is not in jsdom, and the point is the contents anyway. */
function fakeArea(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    area: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(data, items);
      },
    } satisfies StorageArea,
    read: () => data["webmcp:ran"] as Record<string, Record<string, number>> | undefined,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("CallHistory", () => {
  it("identifies a thread by its path, which is what the hosts key on", () => {
    expect(CallHistory.threadKey({ host: "chatgpt.com", pathname: "/c/abc" })).toBe(
      "chatgpt.com/c/abc",
    );
    expect(CallHistory.threadKey({ host: "www.perplexity.ai", pathname: "/search/x" })).toBe(
      "www.perplexity.ai/search/x",
    );
  });

  /**
   * The reported bug, end to end: a call ran, the page was reloaded, and the
   * daemon ran it again because the in-memory de-duplication set had died with
   * the old content script.
   */
  it("survives a page load, so a dispatched call is not dispatched twice", async () => {
    const { area } = fakeArea();

    const first = new CallHistory("host/thread", area);
    expect(await first.load()).toEqual([]);
    await first.record("call:abc");

    const second = new CallHistory("host/thread", area);
    expect(await second.load()).toEqual(["call:abc"]);
  });

  it("keeps threads apart, so another conversation's calls are not written off", async () => {
    const { area } = fakeArea();
    const a = new CallHistory("host/one", area);
    await a.load();
    await a.record("call:abc");

    const b = new CallHistory("host/two", area);
    expect(await b.load()).toEqual([]);
  });

  /** It can date its own action, which is the thing the page cannot do. */
  it("remembers when it ran something", async () => {
    const { area } = fakeArea();
    const clock = { t: 5_000_000 };
    const history = new CallHistory("host/thread", area, () => clock.t);
    await history.load();
    await history.record("call:abc");

    expect(history.ranAt("call:abc")).toBe(5_000_000);
    expect(history.ranAt("call:never")).toBeNull();
  });

  it("forgets threads nobody has touched for a week", async () => {
    const now = 100 * DAY;
    const { area, read } = fakeArea({
      "webmcp:ran": {
        "host/old": { "call:x": now - 8 * DAY },
        "host/recent": { "call:y": now - 1 * DAY },
      },
    });

    const history = new CallHistory("host/new", area, () => now);
    await history.load();
    await history.record("call:z");

    const store = read()!;
    expect(Object.keys(store).sort()).toEqual(["host/new", "host/recent"]);
  });

  /**
   * Storage is not guaranteed — a content script orphaned by an extension
   * reload throws on every `chrome.*` call. Degrading to in-memory costs a
   * forgotten call; throwing would take down the scanner.
   */
  it("degrades to in-memory when storage is unavailable", async () => {
    const broken: StorageArea = {
      get: () => Promise.reject(new Error("Extension context invalidated")),
      set: () => Promise.reject(new Error("Extension context invalidated")),
    };
    const history = new CallHistory("host/thread", broken);

    await expect(history.load()).resolves.toEqual([]);
    await expect(history.record("call:abc")).resolves.toBeUndefined();
    expect(history.ranAt("call:abc")).not.toBeNull();
  });

  it("works with no storage area at all", async () => {
    const history = new CallHistory("host/thread", null);
    await expect(history.load()).resolves.toEqual([]);
    await expect(history.record("call:abc")).resolves.toBeUndefined();
  });
});

describe("CallGate.remember", () => {
  /**
   * The tail case seeding cannot cover: a slow page whose turns hydrate after
   * the seed window has closed. The call then looks brand new, and only the
   * record of having run it says otherwise.
   */
  it("refuses a call a previous session dispatched, however fresh it looks", () => {
    let now = 1_000_000;
    const gate = new CallGate(now, () => now);
    gate.remember(["call:abc"]);

    // Well past the seed window, so seeding is not what is doing the work.
    now += SEED_WINDOW_MS + 1;
    expect(gate.beginScan(true)).toBe(false);
    expect(gate.admit("call:abc", "raw", 700, false)).toBe("already-run");
    // Reported once, then it is an ordinary duplicate.
    expect(gate.admit("call:abc", "raw", 700, false)).toBe("duplicate");
    expect(gate.skipped).toBe(1);
  });

  /**
   * The other half of the same question, and the one that makes the record
   * bounded rather than permanent: what if the model genuinely wants the same
   * command run again?
   *
   * A call is keyed by the text of its block, so a model that reuses its call
   * ids produces byte-identical text for a real repeat. Inside the replay
   * window that is almost certainly the transcript being re-read; an hour later
   * it is the model asking, and refusing it would be the record doing more harm
   * than the bug it was added for.
   */
  it("stops refusing a repeat once the page is no longer replaying its transcript", () => {
    let now = 1_000_000;
    const gate = new CallGate(now, () => now);
    gate.remember(["call:abc"]);

    now += REPLAY_WINDOW_MS + 1;
    gate.beginScan(true);
    expect(gate.admit("call:abc", "raw", 700, false)).toBe("settling");
    now += 701;
    expect(gate.admit("call:abc", "raw", 700, false)).toBe("run");
  });

  it("leaves a call it has never seen alone", () => {
    let now = 1_000_000;
    const gate = new CallGate(now, () => now);
    gate.remember(["call:abc"]);
    now += SEED_WINDOW_MS + 1;
    gate.beginScan(true);

    expect(gate.admit("call:other", "raw", 700, false)).toBe("settling");
    now += 701;
    expect(gate.admit("call:other", "raw", 700, false)).toBe("run");
  });
});

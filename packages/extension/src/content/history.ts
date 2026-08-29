/**
 * What this extension has already run, remembered across page loads.
 *
 * The scanner's de-duplication lives in memory, so a reload empties it and the
 * transcript — which is full of syntactically perfect tool calls — starts
 * looking like a work queue. Seeding covers that by writing off whatever is on
 * screen at attach, but seeding is a heuristic with a tail: on a slow page the
 * turns can hydrate after the window has closed, and then the same replay
 * happens anyway.
 *
 * This is the exact version of the same guard. The page cannot tell us how old a
 * call is — a Perplexity assistant turn carries no timestamp of any kind, and
 * the one timestamp it does render is hover-revealed text on a *user* bubble
 * with no year, no timezone, and nothing stopping a prompt-injected page from
 * writing whatever it likes into it. But we do not need the page to date the
 * call: we ran it, so we can date our own action, and "we already did this" is
 * a stronger answer than "this looks old".
 *
 * Everything here degrades to in-memory on failure. Storage being unavailable
 * must cost a forgotten call, never a thrown exception in the content script.
 */

const STORE_KEY = "webmcp:ran";
/** Threads untouched for this long are dropped, so the store cannot grow forever. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_THREADS = 50;
const MAX_PER_THREAD = 400;

type Store = Record<string, Record<string, number>>;

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class CallHistory {
  /** callKey -> when we dispatched it, for this thread only. */
  private ran = new Map<string, number>();

  constructor(
    private readonly thread: string,
    private readonly area: StorageArea | null = defaultArea(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The conversation this page is showing.
   *
   * Path-based, because that is what identifies a thread on all four hosts
   * (`/c/<id>`, `/chat/<id>`, `/search/<slug>`, `/app/<id>`). A brand-new chat
   * starts at `/` and is given its real URL only after the first message, so a
   * call made in that window is recorded under `/` and not found after a
   * reload. Seeding is what covers that case; this is the belt, not the braces.
   */
  static threadKey(location: { host: string; pathname: string }): string {
    return `${location.host}${location.pathname}`;
  }

  /** Keys this extension has already dispatched in this thread. */
  async load(): Promise<string[]> {
    const store = await this.read();
    const mine = store[this.thread] ?? {};
    this.ran = new Map(Object.entries(mine));
    return [...this.ran.keys()];
  }

  /** When we dispatched `key`, or null if we never did. */
  ranAt(key: string): number | null {
    return this.ran.get(key) ?? null;
  }

  /**
   * Record a dispatch — at dispatch, not at completion.
   *
   * A call that was sent and then aborted must not be retried on the next page
   * load: that is the failure this was reported for. "We started this" is the
   * fact worth remembering; whether it finished is a separate question the
   * conversation itself already answers.
   */
  record(key: string): Promise<void> {
    this.ran.set(key, this.now());
    // Returned rather than swallowed so the write is awaitable — the caller
    // fires and forgets, but a test can tell the difference between "written"
    // and "not written yet", which is the whole point of the thing.
    return this.flush();
  }

  private async flush(): Promise<void> {
    const store = await this.read();
    store[this.thread] = Object.fromEntries(
      // Newest first, then capped: a very long conversation should forget its
      // oldest calls rather than grow without bound.
      [...this.ran.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PER_THREAD),
    );
    await this.write(prune(store, this.now()));
  }

  private async read(): Promise<Store> {
    if (!this.area) return {};
    try {
      const raw = (await this.area.get(STORE_KEY))[STORE_KEY];
      return isStore(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  private async write(store: Store): Promise<void> {
    if (!this.area) return;
    try {
      await this.area.set({ [STORE_KEY]: store });
    } catch {
      /* a forgotten call, not a broken content script */
    }
  }
}

/** Drop stale threads, then the oldest ones, so the store stays small. */
function prune(store: Store, now: number): Store {
  const newest = (calls: Record<string, number>) => Math.max(0, ...Object.values(calls));
  const live = Object.entries(store).filter(([, calls]) => now - newest(calls) < MAX_AGE_MS);
  live.sort((a, b) => newest(b[1]) - newest(a[1]));
  return Object.fromEntries(live.slice(0, MAX_THREADS));
}

function isStore(value: unknown): value is Store {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `chrome.storage.local`, promisified, or null where there is none — a test, or
 * a content script whose extension has been reloaded out from under it.
 */
function defaultArea(): StorageArea | null {
  const local = (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome?.storage
    ?.local;
  return local ?? null;
}

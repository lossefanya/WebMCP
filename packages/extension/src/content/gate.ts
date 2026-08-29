/**
 * What is allowed to run.
 *
 * Split out of the scanner so it can be tested without a DOM, for the same
 * reason `turnsToScan` was: this is a correctness boundary, and every rule in it
 * exists because of a way tool calls got executed that nobody asked for.
 *
 * The scanner's de-duplication lives here too, because de-duplication and
 * freshness are the same question asked twice — "have we already dealt with
 * this?" — and splitting them across two files is how they drift apart.
 */

/**
 * How long after attaching a call may still be treated as history.
 *
 * Everything already in the conversation when the scanner starts is somebody
 * else's turn: it ran, or it was abandoned, and either way a user reopening the
 * tab is not asking for it to be run again. That is the bug this closes — a page
 * reload, an extension reload or a crashed content script empties the
 * de-duplication set, and the next scan finds a transcript full of perfectly
 * valid tool calls and starts working through them.
 *
 * A window rather than a single first scan, because these are SPAs: the first
 * scan can land before the turns have hydrated, and seeding an empty
 * conversation would seed nothing and protect nothing. Five seconds is long
 * enough for every host to render and short enough that nothing genuinely new
 * can fall inside it — a model cannot answer within five seconds of the page
 * that asked it finishing loading.
 */
export const SEED_WINDOW_MS = 5_000;

/**
 * How long a call may sit unrun before it is treated as stale.
 *
 * The second belt behind seeding, for what seeding cannot see: a backgrounded
 * tab whose timers were throttled, or a scan blocked while something else ran.
 *
 * Measured from when *this* code last saw the block change, never from a
 * timestamp on the page. The hosts render those in several localized formats,
 * some of them relative ("2 min ago"), and all of them are text the page
 * controls — a page that can lie about when a call was written could use it to
 * make a stale call look fresh.
 */
export const MAX_CALL_AGE_MS = 30_000;

/**
 * How long after attaching the stored record still has a say.
 *
 * The record exists to stop the *transcript* being replayed, and a transcript
 * replays immediately — the calls are on screen the moment the page renders.
 * Past this window a matching call is not the old one being re-read, it is the
 * model asking again, and the record has no business refusing it.
 *
 * Without this bound the record would be strictly worse than the bug it fixes:
 * a call is keyed by the text of the block, so a model that reuses its call ids
 * would emit byte-identical text for a genuine repeat and have it silently
 * dropped for a week. Generous enough to cover a slow page hydrating long after
 * the seed window, short enough that no mid-conversation repeat falls inside it.
 */
export const REPLAY_WINDOW_MS = 60_000;

export type Admission =
  /** Dispatch it. */
  | "run"
  /** Already dealt with in this session. */
  | "duplicate"
  /** This extension dispatched it in an earlier session. Reported once. */
  | "already-run"
  /** It was on screen before this scanner was, so it is not ours to run. */
  | "history"
  /** Finished long ago and never dispatched; running it now would surprise. */
  | "stale"
  /** Still changing, or not yet still for long enough. Ask again shortly. */
  | "settling";

export class CallGate {
  /** Blocks already dispatched, so a re-render is not a second execution. */
  private readonly handled = new Set<string>();
  /** Block key -> {text, firstSeen}, for the stability check. */
  private readonly seen = new Map<string, { text: string; at: number }>();
  /** Dispatched by an earlier session, recovered from storage. */
  private readonly previous = new Set<string>();
  private seeded = false;
  private skippedCalls = 0;

  constructor(
    private readonly attachedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Open a scan. Returns true while the conversation already on screen is still
   * being written off, which the caller applies to every block it finds.
   *
   * `turnsPresent` closes the window early: once there has been something to
   * seed, seeding is done. Without it a conversation that is genuinely empty
   * would stay armed and swallow the first real call.
   */
  beginScan(turnsPresent: boolean): boolean {
    const withinWindow = this.now() - this.attachedAt < SEED_WINDOW_MS;
    const seeding = !this.seeded && withinWindow;
    if (turnsPresent || !withinWindow) this.seeded = true;
    return seeding;
  }

  /**
   * Take on what a previous session recorded as dispatched.
   *
   * Kept apart from `handled` so the first sighting can be *reported* rather
   * than silently swallowed: "already run two days ago" is the answer to "why
   * did nothing happen", and folding it into ordinary de-duplication would log
   * it on every poll or not at all.
   */
  remember(keys: Iterable<string>): void {
    for (const key of keys) this.previous.add(key);
  }

  admit(key: string, raw: string, settleMs: number, seeding: boolean): Admission {
    if (this.handled.has(key)) return "duplicate";

    // Checked before seeding: this is the one branch that knows rather than
    // infers. A call we dispatched in an earlier session is not re-run however
    // fresh the page makes it look — but only while the transcript is still
    // what we are looking at. See `REPLAY_WINDOW_MS`.
    if (this.previous.has(key)) {
      if (this.now() - this.attachedAt < REPLAY_WINDOW_MS) {
        this.handled.add(key);
        this.skippedCalls += 1;
        return "already-run";
      }
      // Long past the load: this is the model asking again, not the page
      // showing us the same message. Forget the old dispatch and treat the call
      // on its merits.
      this.previous.delete(key);
    }

    if (seeding) {
      this.handled.add(key);
      this.skippedCalls += 1;
      return "history";
    }

    // A JSON object can be *valid* while still incomplete — `{"tool":"fs_write"}`
    // parses fine before `args` arrives — so a block also has to stop changing
    // before it is allowed to run.
    const previous = this.seen.get(key);
    if (!previous || previous.text !== raw) {
      this.seen.set(key, { text: raw, at: this.now() });
      return "settling";
    }
    const still = this.now() - previous.at;
    if (still < settleMs) return "settling";

    // Stale rather than merely slow. The clock above restarts whenever the text
    // changes, so this measures from the block's last edit: a call that streamed
    // for a minute is not stale; one that has sat finished and unrun for thirty
    // seconds is.
    if (still > MAX_CALL_AGE_MS) {
      this.handled.add(key);
      this.skippedCalls += 1;
      return "stale";
    }

    this.handled.add(key);
    return "run";
  }

  /** Calls deliberately not run, for the diagnostics report. */
  get skipped(): number {
    return this.skippedCalls;
  }
}

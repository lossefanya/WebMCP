# 2026-08-29 — Two bugs that only a long session finds

Both reported from real use, and neither reproducible in a short one: `git clone` returning nothing
useful, and Chrome going unresponsive part-way through a run of file reads. The first was a timeout
the model could not raise and was never told about. The second was the scanner getting slower with
every result it pasted — a session compounding its own cost.

**Final state:** 388 tests green (207 daemon, 181 extension), up from 380. +138 / −19 across seven
files, plus `extension/test/scan-cost.test.ts`.

---

## `git clone` gave the model nothing to act on

Reported as "it didn't give feedback after clone is done, so the AI doesn't know if the work is
done". The daemon turned out to be innocent — a real clone through it returns exactly what you would
want, including git's progress, which all goes to **stderr**:

```
$ git clone /private/tmp/gt/origin cloned
[exit 0]
--- stderr ---
Cloning into 'cloned'...
done.
```

Three things behind the symptom instead, and only the first is obvious:

1. **The default timeout is 30s** and a real network clone routinely exceeds it, so it was SIGKILLed
   part-way.
2. **The model could not do anything about that.** `limit` was
   `Math.min(asked ?? timeoutMs, timeoutMs)` — `timeout_ms` could only ever *lower* the ceiling.
   Asking for five minutes silently got thirty seconds.
3. **Nothing said so.** The parameter was documented as "Kill the process after this long" with no
   mention of a cap, and the kill message was a bare `[timed out after 30000ms]` — a dead end.

**Fix:** `exec.maxTimeoutMs` (5 min) is now the ceiling and `exec.timeoutMs` (30s) only the default,
so a call can ask for more. The default stays short deliberately: an unattended wedged command must
not hold a chat turn for minutes. And the kill message carries the remedy, because that text is
pasted into the conversation and is the only thing the model gets to act on:

```
[timed out after 1500ms — retry with timeout_ms up to 300000 if it needs longer]
```

The general shape is worth keeping: **an error a model reads should end with what to do next.** A
status line is an interface, not a log entry.

### A NaN timeout that silently killed everything

Adding the field broke the truncation test, and the reason was worse than the break. `testConfig`
overrides replace a block wholesale, so an `exec` override written before the field existed left
`maxTimeoutMs` undefined — and `Math.min(x, undefined)` is `NaN`, and `setTimeout(fn, NaN)` fires
**immediately**. Every command would have been killed the instant it started, which presents as "the
command produced no output" rather than as an error.

Fixed in the code and not only in the test: a missing or non-finite ceiling degrades to the default.
A config the daemon writes always has the field; a hand-edited one might not.

---

## The scanner got slower with every result it pasted

The reported symptom was pasting: "while reading many files, Chrome couldn't catch up — I guess due
to pasting too many texts in short time." The pasting was not the problem, and chasing it would have
wasted the session.

`touchesUserTurn` costs a full subtree `querySelector` per marker — there are nine — per turn. `scan`
ran it across **every turn in the conversation** and then took the last two:

```js
const turns = this.site.assistantTurns().filter((turn) => !touchesUserTurn(turn));
// Only the tail can contain a new call, and scanning a long conversation on
// every mutation is how an extension makes a chat UI feel broken.
for (const turn of turns.slice(-2)) {
```

The comment is right and sits directly above code doing the expensive half first. Every pasted result
adds a turn; every later scan walks all of them; scans run on every mutation and on a 1.5s poll. A
session that reads many files makes itself slower with every file it reads.

**Fix:** bound the window before the per-turn work, not after. Extracted as a pure `turnsToScan()` so
the cost could be measured rather than asserted in prose — which, given the previous entry's lesson
about comments that name a hazard, was the point.

| conversation | subtree walks |
|---|---|
| 500 turns | 103 |
| 5,000 turns | 104 |

Reverting the fix fails four of the five new tests, and the first one goes from **437ms to 91
seconds**. That ~200× in jsdom is the thing that was happening in Chrome.

The window (8) is deliberately wider than the depth (2): the filter is a safety net against a
selector that over-matches, so it wants slack — bounded slack.

---

## What I'd do differently

**The reporter's diagnosis is a symptom, not a cause.** "Too much pasting" was a reasonable read of
the evidence and pointed at the wrong half of the system. Taking it at face value would have produced
a paste throttle that made everything slower and fixed nothing. The useful move was to ask what runs
per scan, not what runs per paste.

**Three test-harness bugs in one file, all of them mine, all of them looking like real findings.**
`vi.spyOn` stacks unless restored, so earlier tests inflated later counts. `conversation()` clears the
body, so building both fixtures up front left the first one detached and measuring something else.
And I asserted exact equality on a count jsdom varies by one between the first and second measurement
in a process. Each one presented as a genuine cost difference and cost a round trip. When a
measurement disagrees with the model of the code, suspect the measurement first — I did the opposite
twice.

**Say which number is the claim.** The final assertion is "constant to within a couple of calls", with
the measured values and the reason written next to it. Exact equality would have been testing jsdom.
A tolerance without a stated justification would have been hand-waving. Neither is better than an
assertion that says what it means.

---

## Open items

- **Paste size is untouched.** `limits.maxReadBytes` is 64KB, and a 64KB insert into TipTap, Quill or
  Lexical is genuinely expensive — they parse it into a document model. It is the next lever if the
  tab is still heavy, and deliberately not pulled speculatively.
- **`assistantTurns()` is still a document-wide `querySelectorAll` per scan.** One native call rather
  than N subtree walks, so it is not the pathology, but it is still linear.
- **`deliver()` giving up is invisible to the model.** Twenty retries at 1.5s, then a report to the
  popup only — the conversation stalls with no explanation in it. Same user-visible symptom as a
  timeout, different cause, and currently indistinguishable from the chat.
- Everything still open from the previous entries: readers can carry a standing allow, exec arguments
  are never path-checked, `Policy.revoke` has no UI.

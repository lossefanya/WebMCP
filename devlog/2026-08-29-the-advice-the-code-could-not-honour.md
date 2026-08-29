# 2026-08-29 — The advice the code could not honour

A question, not a bug report: "when injecting, does it explain about the cap, so the model can read a
large file in split?" The answer was yes — the preamble says exactly that. Checking *how well* it
worked turned up that the instruction was a promise `fs_read` could not keep.

**Final state:** 395 tests green (214 daemon, 181 extension), up from 388. +199 / −17 across
`daemon/src/tools/fs.ts` and its test.

---

## The instruction was fine. The implementation was not.

The preamble renders each tool's own description, so the model does see:

```
- `fs_read(path: string, offset?: number, limit?: number)` — Read a UTF-8 text file
  from the workspace. … Long files are truncated; use offset/limit to page through them.
```

and every truncated read carries the true size in its header — `large.txt (271890 bytes)`.

But `fs_read` read the first `2 * maxReadBytes` **from byte zero** and *then* sliced lines out of that
buffer. So `offset` only ever indexed into the first chunk, and every line past it was unreachable by
any argument the model could pass. On a 271KB file with a 4KB budget:

| request | before |
|---|---|
| `offset: 1` | line 0 |
| `offset: 40` | line 39 — still inside the cap |
| `offset: 100` | **empty** |
| `offset: 2000` | **empty** |

No error, no explanation: a header claiming 271,890 bytes followed by nothing. That reads as "the file
is empty here" rather than "you asked for something I cannot do", which is a good way to send a model
round in circles paging a file it has already finished.

The worst part is the combination. The tool description *instructs* the model to page, so the failure
is reached by following the documentation. Advice a caller cannot act on is worse than no advice — it
spends turns and produces confident wrong conclusions about the file.

**Fix:** walk the file in 64KB chunks counting lines, stop as soon as the range is satisfied, and
never hold the file in memory. `StringDecoder` carries partial UTF-8 across chunk boundaries; splitting
a buffer mid-code-point and decoding each half independently is how a scanner like this corrupts
non-ASCII text, so that is tested with Korean at line 3,500 rather than assumed.

A full paged walk now covers exactly 3,000 lines in 137 pages and terminates cleanly.

### The footer was lying about the denominator

```
[webmcp: truncated — showed 2037 of 4096 bytes]
```

4,096 was the internal read cap, not the file. A 271KB file described as 4,096 bytes reads as "you
have about half", when the model had 0.75%. The true size was already on the result as
`originalBytes`, but `renderToolResult` pastes only `c.text` — so the metadata never reached the
conversation and the wrong number was the only one that did.

Now the byte budget is enforced *inside* the line scan, so nothing is truncated after the fact and the
footer can state the range and the next call exactly:

```
[webmcp: showed lines 1-23 of large.txt (271890 bytes).
 Continue with {"path": "large.txt", "offset": 24}]
```

Same principle as the exec timeout message earlier today: **an error a model reads should end with
what to do next.** Both were dead ends stating a fact; both are now a fact and a move.

Asking past the end is likewise an answer rather than an empty body:
`offset 9999 is past the end — large.txt has 3000 lines`.

---

## What I'd do differently

**"Is it documented?" and "does the documented thing work?" are different questions, and only the
second one matters.** The honest answer to what was asked was "yes, here is the line". Running it was
an afterthought that found the real problem. A documentation question is worth treating as a claim to
test, because documentation is exactly where an untested promise hides.

**The metadata/rendering split hid this.** `originalBytes` was correct on the result the whole time
and never reached the model, because the text protocol pastes text and drops everything else. Any
field the daemon computes for the model's benefit is decoration unless it is in the string. Worth a
sweep for others.

**Test the walk, not the page.** The single most useful assertion here was paging the whole file and
checking every line arrives exactly once — an off-by-one in the resume offset shows up as a duplicate
or a hole, where a test of one page at one offset would have passed against a resume that skipped a
line every time.

---

## Open items

- **`renderToolResult` still drops `truncated` and `originalBytes`.** Fixed at the source for
  `fs_read` by putting the numbers in the text, but the general gap remains for any tool that sets
  them.
- **`fs_list` still uses the old `truncate`** and reports the body's own length, which is correct
  there but shares the notice wording that just changed for reads. Worth aligning.
- **A file rewritten between pages is not detected.** Offsets are line numbers with no revision
  behind them, so paging a file that changes underneath silently interleaves old and new content.
- Everything still open from the previous entries: `deliver()` giving up invisibly, readers carrying
  a standing allow, exec arguments never path-checked, `Policy.revoke` with no UI.

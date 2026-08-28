# 2026-08-29 — The exec allowlist is not a boundary, and "Always allow" made that matter

Started as a one-word change — add `mkdir` to the exec allowlist, because Gemini had just been refused
one — and turned into the first real security review of `exec_run`. The allowlist turns out not to
contain anything, and a single reasonable-looking click turned that from a documented trade-off into
unattended arbitrary code execution.

**Final state:** 380 tests green (204 daemon, 176 extension), up from 362. +241 / −19 across five
files, no new ones. Every escape below was executed against a live jailed daemon, not reasoned about.

---

## The question that was actually worth asking

The `mkdir` request was trivial: it was on no list, `fs_write` with `create_dirs` makes parents on the
way to a file but nothing made a bare empty directory, so the hole was real and one line closed it.
Noting in passing that `mkdir` is far less dangerous than `node` and `npx`, already on the list,
prompted the better question — *with the current set of commands, is there any chance to get a
security problem?*

Answering it by reading the code would have produced a confident and partly wrong answer. Running it
produced this. Daemon jailed to `/tmp/sec/ws`, target file in `/tmp/sec/outside`:

| call | result |
|---|---|
| `fs_read /tmp/sec/outside/secret.txt` | refused — `jail_violation` |
| `cat /tmp/sec/outside/secret.txt` | printed `SECRET` |
| `awk 'BEGIN{system("cat …")}'` | printed `SECRET` |
| `find . -exec cat … ;` | printed `SECRET` |
| `node -e "fs.writeFileSync('…/outside/pwned.txt')"` | **wrote outside the jail** |
| `python3 -c "open('…').read()"` | printed `SECRET` |
| `git -c alias.x='!cat …' x` | printed `SECRET` |
| `sed -i -e s/SECRET/OWNED/ …` | **modified a file outside the jail** |
| `make all` with a Makefile `fs_write` had created | printed the file |

Nine for nine. The jail covers `fs_*` and nothing else: `checkExecArgs` validates that the command is
a bare binary name and rejects null bytes in arguments, and never looks at a path. `cwd` is the
workspace, so *relative* paths land inside it, and that is the entire containment story.

None of this is a regression — it is how exec was built, and `CLAUDE.md` describes it accurately
("`spawn(cmd, argv, {shell: false})`, keep a binary allowlist"). But an allowlist sitting a paragraph
below the jail rules reads as containment, and it is a typo filter.

### The part that turned a trade-off into a vulnerability

Per-call approval is a real check: the human sees the exact argv before it runs. A standing allow is
not, because `allowKey` returns `exec_run:${command}` — the binary, with no constraint on arguments.

Verified end to end against a running daemon:

```
prompt 1: Run node -e console.log('hello')
  button: Always allow `node` in ws
call 2 output: EXFIL: OWNED
call 2 was prompted for: false
```

Approve a harmless `node -e "console.log('hello')"` with **Always**, and every later `node -e
<anything>` runs unprompted. Against a threat model whose first line is "the page is hostile and can
inject tool calls", that is one plausible click buying unattended arbitrary code execution — reading
any file the user can read, writing anywhere, reaching the network. The audit log recorded it, which
is worth something, but only after the fact.

**Fix:** a `NO_STANDING_ALLOW` set — every binary verified escaping above, plus obvious siblings
(`sh`, `bash`, `zsh`, `perl`, `ruby`, `env`, `xargs`, `python`). Those are asked about every time,
forever.

Two layers, because the button is a hint and not a control:

- `alwaysLabel` returns `undefined`, so the popup does not render it;
- `allowAlways` refuses to record the rule even when a decision claiming `allow_always` arrives
  anyway, and audits the refusal. The call still runs — a human did approve it — only the standing
  grant is refused.

The second is the one that matters. The extension renders prompts; it does not decide what the daemon
may remember. A fix that only removed the button would be a fix in the half that is not the trust
boundary.

Rules already in `allowlist.json` for those binaries are dropped on load with a warning. Otherwise the
fix protects only the people who had not yet clicked the thing it exists to stop.

Re-running the same exploit afterwards:

```
call 1 always-allow button : NOT OFFERED
call 2 raised a prompt      : yes
unattended exec possible    : false
```

---

## Also this session

- **`mkdir` added to `DEFAULT_EXEC_ALLOW`**, with a test that creates a directory rather than
  asserting a string is in an array. It is among the least powerful entries on the list.
- **Five existing policy tests used `git` as their standing-allow example**, which is now exactly what
  is disallowed. Moved to `ls`. Worth noting the shape of that: the tests were written against the
  behaviour, so the behaviour changing broke them correctly — the temptation was to keep `git`
  permitted so the diff stayed small.

---

## What I'd do differently

**Run the attack, do not reason about it.** A reading of `checkExecArgs` gives "arguments are not
path-checked", which is true and sounds like a caveat. Nine commands actually escaping a live jail is
the same fact and a completely different sentence. The demo took four minutes and changed what got
built.

**A security answer assembled from memory would have been wrong in both directions.** I would have
named `node` and `python3` and probably missed `awk 'BEGIN{system()}'`, `find -exec`, and
`git -c alias`. `sed -i` writing to an absolute path is obvious in hindsight and was not on my list
before running it.

**Read the throwaway script's output before quoting it.** The first exploit re-run printed `LEAKED:`
against the *harmless* call, because two `if`s matched the same message where the original had
`else if`. The audit log said plainly that the second call was `DENIED`. Ten more seconds of reading
before reporting would have caught it; instead the correction happened in front of the user.

---

## Open items

- **Readers can still carry a standing allow.** `cat`, `grep`, `head`, `tail`, `ls`, `rg` all read
  absolute paths, so "Always allow `cat`" permits an unattended `cat ~/.ssh/id_rsa` with the output
  landing in the conversation — arbitrary file read plus exfiltration, without code execution. Raised
  with the user; the split shipped as agreed, and this half is knowingly still open.
- **Exec arguments are still never path-checked.** Rejecting absolute paths and `..` by default would
  close the readers and the `sed -i` write without touching `node -e`. Partial, and it would break
  legitimate calls, which is why it was not the first move.
- **`CLAUDE.md` still presents the allowlist next to the jail rules** in a way that reads as
  containment. The prose should say what the demo showed: the jail is the boundary, the allowlist is a
  filter, and the approval prompt is the control.
- **`Policy.revoke` remains unreachable from any UI** — standing grants are added from the popup and
  removed only by editing `allowlist.json`. More pointed now that which grants are possible has
  changed underneath existing files.

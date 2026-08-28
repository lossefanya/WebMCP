# 2026-08-29 — Moving the workspace without restarting, and five bugs the users found

Started with one question — "I want to change working dir without re-running the daemon" — and ended
up touching the security model, the state directory, the popup, and the documentation rules. Five
real bugs came out of it. I found one by writing a test; the user found the other four by using the
thing, which is the honest ratio.

**Final state:** 362 tests green (186 daemon, 176 extension), up from 296 at the end of the last
session. +1,225 / −78 lines across 20 existing files, plus three new ones: `daemon/src/workspace.ts`,
`daemon/test/workspace.test.ts`, `extension/test/popup.test.ts`. Shipped as `f36a313` and `810069f`
on `runtime-workspace-switching`.

**Amended after the fact.** The last bug below was found the following session, once the branch was
already pushed — the picker had never actually been used by a human when this was first written. It
belongs here rather than in its own entry, because it is this feature and it is the sharpest instance
of the pattern the rest of the entry is about.

---

## The feature

The workspace root was frozen at startup by design — `Workspace` is the jail, and a jail that can be
moved by whoever it contains is not one. The whole product promise is "it can only touch the
directory I named," so making that directory movable is a change to the security model, not a
convenience feature.

The resolution: **a switch is a selection from a list the user wrote on disk, never a way to name
somewhere new.** Two routes, both routing the *grant* through the config file, which is the one
channel the browser cannot reach:

- `--set-workspace <dir>` writes `workspace` and unions the directory into `workspaces`, then exits.
  A config watcher picks it up in a running daemon. This is how a **new** directory is granted.
- `set_workspace` on the wire, reachable only from the popup's picker, **selects** among roots already
  in `workspaces`. It cannot add one.

`packages/daemon/src/workspace.ts` (192 lines) owns the live root. `Workspace` stayed immutable; a
switch builds a new one and swaps the reference.

Narrowing into a subdirectory of a granted root is free — strictly less reach. The *parent* of a
granted root is a widening and is refused, which is the case worth having a test for.

---

## The bug I found by writing the test

I had the server read the live root at execution time. The sequence is: claim the call id → validate →
**wait for a human** → run. So a switch while a prompt was open redirected the write: the user
approves "write `config.json` in *project-a*" and it lands in *project-b*.

The prompt names a directory. Anything that runs somewhere else is the daemon doing something other
than what was agreed to.

**Fix:** the jail is pinned when the call is claimed, before the approval wait, and threaded through
`validate`, `Policy.decide`, `alwaysLabel`, `allowAlways` and `registry.call`. `Registry` no longer
holds the manager at all — the caller names the jail, because the server is the thing that sequences
approval and therefore the thing that knows which jail a call belongs to.

I checked the regression test by reverting the fix: it fails with `ENOENT` on the expected file. A
test for a race that passes both ways is not a test.

### Standing allows had the same shape of problem

`allowKey` returned `exec_run:git` with no root in it, while the button has always read "Always allow
`git` in *project*". Once the root can move, that grant silently follows you into a directory nobody
approved it for.

Rules are now keyed `scopedKey(root, key)`. Switching away suspends a grant; switching back restores
it — it was never revoked, only out of scope. Rules written before scoping carry no root, so they are
**dropped on load** rather than assigned to a guess. One extra prompt beats a standing grant applied
to a directory nobody named.

---

## Four bugs the user found

### The popup had no tests at all, and I said so only when asked

"I reloaded the extension but I don't see any button to change work dir."

Three causes, and the diagnosis mattered more than the fix:

1. **Their daemon was running old code.** Started 22:43, before any of this existed. I had rebuilt
   `dist/` at 00:02, but a running Node process does not reload from disk. It never sent `roots` in
   `ready`, so the extension correctly hid a picker with nothing in it.
2. **One granted root**, so there was nothing to pick between anyway.
3. **I had broken their pairing without warning.** Moving state from `~/.webmcp/` to the project's
   `.webmcp/` meant the daemon found no token there and minted a fresh one. Their extension was still
   paired to the old one. Copying the token across fixed it, but I should have flagged it when the
   move was requested — the cost of a state-directory move is exactly this, and it was foreseeable.

Everything else this session had been verified against a running daemon. The popup had been
*typechecked*. That gap only surfaced because someone tried to use it.

It now has 20 tests, loaded against the real `public/popup.html` rather than a fixture copy, so a
renamed id in either file breaks the test instead of breaking silently in a browser.

### The grant was never announced

> "dir selector should appear even if there's only 1 dir in the list. otherwise user has to reload
> extension after adding second dir"

The second half was a genuine bug, not a preference. `WorkspaceManager.reload` notified listeners only
when the **active root moved**. Granting a second directory leaves the active root exactly where it
is — so nothing was broadcast, and every already-connected popup kept showing a stale list until it
happened to reconnect. Indistinguishable from the grant having failed.

My own verification had hidden it: `probe roots` opens a *fresh connection* each time and gets current
roots in `ready`. It could never have caught a missing push to an *existing* connection. A check that
cannot observe the failure mode is not a check.

**Fix:** broadcast whenever the *set* changes, not just the active root — including revocation — while
a no-op reload stays quiet so the watcher firing on unrelated writes does not spray every session.
Verified with a client that connects once and never reconnects.

The first half was a fair UX call I had got wrong. I hid the picker below two roots on the grounds
that a one-entry dropdown reads as broken. But the hint naming `--set-workspace` — the only way to
add a second — was hidden along with it, so the control appeared only once you no longer needed
telling. It is now always visible, and inert with a single root.

### Messages disappeared in under a second

> "error messages / notice disappear too fast"

`render()` ended by rewriting the message line, and the approval countdown calls `render()` every
second. Every message lived under a second regardless of what set it.

Worse, I had already "fixed" this once — by calling `refresh()` *before* showing the notice, so it
survived the immediate redraw. That treated the symptom and left the recurring redraw untouched.

**Fix:** the line now carries two kinds of content with different lifetimes. *Ambient* text describes
a standing condition and is recomputed every redraw. A *flash* answers something the user just did,
survives redraws, and (after a follow-up) stays until clicked — a message that removes itself is a
message that can be missed, and the popup is often not the window being looked at.

Two things fell out of it: confirmations were rendering red like failures, which trains you to ignore
the line that also carries real errors, so they got their own tone; and ambient text is deliberately
*not* dismissible, since clearing it would last one second and read as broken.

### The picker could not be used at all, and the comment above it said why

The one that matters most, because everything above it was verification theatre by comparison: you
select the second directory in the dropdown and within a second it snaps back to the first, so the
Switch button is never reachable. Not "awkward" — the feature could not be operated.

`renderSwitcher` pushed the active root into the `<select>` on every render, and render runs once a
second to keep the approval countdown moving. The user's half-made choice was read as a disagreement
to correct.

The hazard was known. The comment directly above that code, written by me, said *"resetting a
`<select>` under someone mid-choice would make it unusable"* — and the guard was applied to the
**options rebuild** while the **value assignment three lines below it** stayed unconditional. I
identified the failure mode precisely, fixed the half I happened to be looking at, and wrote the
other half down as prose instead of as an assertion.

The 20 popup tests written a few hours earlier did not catch it. One of them —
`does not rebuild the dropdown on the one-second redraw` — tests the *adjacent* line. A test aimed
two statements to the left of the bug, in a file I had just written specifically because the popup
was untested.

**Fix:** track the active root separately, and push the value only when it *changes* — a switch from
this popup, another tab, or `--set-workspace` in a terminal. Comparing against `pick.value`, as
before, cannot distinguish "the daemon moved" from "the user is choosing". Two tests: the selection
survives 2.5s of redraws (fails against the old code with `expected 'project-a' to be 'project-b'`),
and the control still follows a move made elsewhere, so the guard does not freeze it instead.

The daemon was verified innocent before touching the popup — a switch holds, and the tools read from
the new root six seconds later. Worth doing: "it reverts" reads like state being overwritten
server-side, and the temptation was to go looking there first.

---

## The documentation rule

Asked to double-check the README, I found two claims that had drifted, neither of them mine:

- it listed three supported hosts long after gemini.google.com shipped with an adapter, a manifest
  entry and a DOM fixture;
- it said the daemon "prints a pairing token on first run" long after that changed to every run.

Both read as entirely plausible. Nothing compiles a README and no test fails when it lies, so it goes
stale silently and the staleness is invisible precisely to the person best placed to notice.

`CLAUDE.md` now opens with a rule: any change a user could notice belongs in `README.md` in the same
pass as the code, with a trigger list (CLI flags, config keys, on-disk locations, what reloads versus
what needs a restart, supported hosts, security-relevant behaviour) and two habits — verify claims
against the code rather than memory, and explain every key you show in an example.

I then held myself to it: the documented config example is extracted from the README by the test and
booted as a real daemon, and the `exec.allow: []` claim was checked by listing tools rather than by
reading `registry.ts`.

---

## Also done

- **State moved to `.webmcp/` in the project root**, not `$HOME`. Resolved by walking up from the
  daemon module to the npm workspace root rather than from `cwd`, so where you were standing when you
  typed the command cannot change which config is read. Config, token and allowlist were already one
  directory (`stateDir = dirname(configPath)`), so this was a change of *which* directory, not a
  scattering fix.
- **Config watching watches the directory, not the file.** Editors and `writeFile` replace the config
  rather than truncating it, so a watch bound to the old inode goes silent after the first save.
  Verified against in-place writes, atomic renames, a second edit *after* a rename, and a half-saved
  file (kept the current config, waited for the next write).
- **`--workspace` is dropped on reload.** It says where to *start*, not where to stay; leaving it in
  would make a daemon started the documented way unmovable.
- **A reload moves the root only when `workspace` itself changed**, remembered across reads. Otherwise
  touching the file to add an MCP server yanks the user out of a root they picked in the popup.
- **`scripts/probe.mjs` gained `roots` and `workspace <dir>`**, so both routes are drivable without a
  browser.

---

## What I'd do differently

**Verify through the same door the user walks through.** `probe roots` proved the daemon knew about
the new root and proved nothing about whether a connected client was told. Every check I ran was a
fresh connection; the bug lived exclusively in long-lived ones. The tool was convenient rather than
representative, and I preferred it for that reason.

**Say what a change costs at the moment it is requested.** Moving the state directory breaks pairing.
That was foreseeable, I did not say it, and the user hit it as a mystery instead of an expected
consequence.

**A green suite over untested code is not evidence.** The popup went through five changes typechecked
and unexercised while I reported "all tests pass" after each. True, and beside the point. It is worth
naming which parts of a change are verified and which are merely compiled.

**Mutation-test anything guarding a race or a redraw.** Six fixes this session were confirmed by
re-breaking them: the approval-wait pin, the dropdown rebuild, the notice ordering, the missing
broadcast, the message expiry, the picker snap-back. Two of those tests would have passed against the
broken code if I had written them slightly differently.

**A comment is not a test, and writing one is not doing the other.** The snap-back was described
accurately in a comment sitting directly above the line that caused it. Prose that identifies a
hazard reads, to the person who wrote it, exactly like a hazard that has been handled — which makes
it worse than saying nothing, because it stops the search. When a comment names a failure mode, that
sentence is a test that has not been written yet.

**Click the thing.** Every bug the user found this session was in the half I could not exercise from a
terminal, and the last one made the feature completely unusable by anyone. jsdom proved the markup,
the wiring and the logic agreed with each other; it could not prove that a human can operate the
control, because it never has to wait a second between two actions. "Verified in jsdom, not in
Chrome" was recorded as an open item and then not treated as one.

---

## Open items

- ~~The picker is verified in jsdom, not in Chrome.~~ **Closed by the snap-back bug**, which is what
  was hiding behind this line: the gap was not rendering, it was that jsdom never waits a second
  between two human actions. Still unconfirmed in Chrome are the parts jsdom cannot see at all —
  layout, the disabled/greyed states, and whether the notice line is legible.
- No CLI flag grants a directory *without* also switching to it — `--set-workspace` does both. Adding
  to the list alone means editing the config by hand, which works and is documented, but a
  `--grant-workspace` would be more honest about the two operations being different.
- Only the workspace fields reload. `port`, `exec.allow` and `mcpServers` are wired into objects built
  at startup and still need a restart. The code says so rather than pretending otherwise, but the
  asymmetry is a rough edge.
- `Policy.revoke` is still unreachable from any UI — standing grants can be added from the popup and
  removed only by editing `allowlist.json`.

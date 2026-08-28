import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager, WorkspaceRefused } from "../src/workspace.js";
import { silentLogger, tempWorkspace } from "./helpers.js";

/**
 * The workspace can move at runtime, so these tests exist to pin the one thing
 * that must stay true while it does: a move is a *selection* from a set a human
 * wrote in the config file, never a way to reach somewhere new.
 */
describe("WorkspaceManager", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;

  beforeEach(async () => {
    fixture = await tempWorkspace();
  });
  afterEach(() => fixture.cleanup());

  it("starts on the active root and offers the granted ones", () => {
    expect(fixture.workspaces.root).toBe(fixture.root);
    expect(fixture.workspaces.roots()).toEqual([fixture.root, fixture.other]);
  });

  it("switches to a granted root", async () => {
    const moved = await fixture.workspaces.switchTo(fixture.other);
    expect(moved.root).toBe(fixture.other);
    expect(fixture.workspaces.root).toBe(fixture.other);
    // And back: the root it came from stays on the list.
    expect(fixture.workspaces.roots()).toContain(fixture.root);
    await fixture.workspaces.switchTo(fixture.root);
    expect(fixture.workspaces.root).toBe(fixture.root);
  });

  it("refuses a directory that was never granted", async () => {
    await expect(fixture.workspaces.switchTo(fixture.outside)).rejects.toThrow(WorkspaceRefused);
    expect(fixture.workspaces.root).toBe(fixture.root);
  });

  it("refuses a parent of a granted root — that is a widening, not a switch", async () => {
    await expect(fixture.workspaces.switchTo(path.dirname(fixture.root))).rejects.toThrow(
      /not one of the workspaces granted/,
    );
    expect(fixture.workspaces.root).toBe(fixture.root);
  });

  it("allows narrowing into a subdirectory of a granted root", async () => {
    const nested = path.join(fixture.root, "sub", "deeper");
    await fsp.mkdir(nested, { recursive: true });
    const moved = await fixture.workspaces.switchTo(nested);
    expect(moved.root).toBe(await fsp.realpath(nested));
    // Still reachable back up, because the parent is what was granted.
    await expect(fixture.workspaces.switchTo(fixture.root)).resolves.toBeDefined();
  });

  it("resolves symlinks before deciding — the classic escape", async () => {
    // A link *inside* a granted root pointing at an ungranted directory. A
    // prefix check on the requested string would pass this; resolving first is
    // what refuses it.
    const link = path.join(fixture.root, "shortcut");
    await fsp.symlink(fixture.outside, link);
    await expect(fixture.workspaces.switchTo(link)).rejects.toThrow(WorkspaceRefused);
    expect(fixture.workspaces.root).toBe(fixture.root);
  });

  it("refuses a path that does not exist, and a null byte", async () => {
    await expect(fixture.workspaces.switchTo(path.join(fixture.root, "nope"))).rejects.toThrow(
      WorkspaceRefused,
    );
    await expect(fixture.workspaces.switchTo("/tmp\0/x")).rejects.toThrow(/null byte/);
    await expect(fixture.workspaces.switchTo("")).rejects.toThrow(WorkspaceRefused);
  });

  it("refuses a file", async () => {
    const file = path.join(fixture.root, "a.txt");
    await fsp.writeFile(file, "x");
    await expect(fixture.workspaces.switchTo(file)).rejects.toThrow(WorkspaceRefused);
  });

  it("notifies listeners once per real move, and not for a no-op", async () => {
    const seen: string[] = [];
    const stop = fixture.workspaces.onChange((ws) => seen.push(ws.root));

    await fixture.workspaces.switchTo(fixture.other);
    await fixture.workspaces.switchTo(fixture.other);
    expect(seen).toEqual([fixture.other]);

    stop();
    await fixture.workspaces.switchTo(fixture.root);
    expect(seen).toEqual([fixture.other]);
  });

  describe("reload", () => {
    it("moves when the configured root changed", async () => {
      const moved = await fixture.workspaces.reload(fixture.other, [fixture.root]);
      expect(moved).toBe(true);
      expect(fixture.workspaces.root).toBe(fixture.other);
    });

    it("leaves a hand-picked root alone when the config was touched for another reason", async () => {
      // The user switched to `other` in the popup. The config still says `root`
      // because that is where the daemon started — re-reading it must not drag
      // them back.
      await fixture.workspaces.switchTo(fixture.other);
      const moved = await fixture.workspaces.reload(fixture.root, [fixture.other]);
      expect(moved).toBe(false);
      expect(fixture.workspaces.root).toBe(fixture.other);
    });

    it("picks up a newly granted root without moving", async () => {
      const extra = path.join(fixture.outside, "granted-later");
      await fsp.mkdir(extra);
      await fixture.workspaces.reload(fixture.root, [fixture.other, extra]);
      expect(fixture.workspaces.root).toBe(fixture.root);
      await expect(fixture.workspaces.switchTo(extra)).resolves.toBeDefined();
    });

    it("announces a newly granted root even though the active one did not move", async () => {
      // Granting a second directory leaves the current one where it was. If
      // that goes unannounced, every already-connected popup shows a stale list
      // until it happens to reconnect — indistinguishable from the grant not
      // having worked.
      const seen: string[][] = [];
      fixture.workspaces.onChange(() => seen.push(fixture.workspaces.roots()));

      const extra = path.join(fixture.outside, "granted-later");
      await fsp.mkdir(extra);
      const moved = await fixture.workspaces.reload(fixture.root, [fixture.other, extra]);

      expect(moved).toBe(false);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(extra);
    });

    it("stays quiet when the reloaded config changed nothing", async () => {
      // The watcher fires on any write to the directory, so a no-op reload must
      // not spray workspace_changed at every session.
      const seen: unknown[] = [];
      fixture.workspaces.onChange(() => seen.push(1));
      await fixture.workspaces.reload(fixture.root, [fixture.other]);
      expect(seen).toEqual([]);
    });

    it("announces a root being revoked, too", async () => {
      const seen: string[][] = [];
      fixture.workspaces.onChange(() => seen.push(fixture.workspaces.roots()));
      await fixture.workspaces.reload(fixture.root, []);
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain(fixture.other);
    });

    it("keeps the current root when the reloaded config names nothing usable", async () => {
      const gone = path.join(fixture.outside, "not-there");
      const moved = await fixture.workspaces.reload(gone, [gone]);
      expect(moved).toBe(false);
      expect(fixture.workspaces.root).toBe(fixture.root);
    });

    it("never drops the root it is standing in, even if the config stops listing it", async () => {
      await fixture.workspaces.switchTo(fixture.other);
      await fixture.workspaces.reload(fixture.root, []);
      // Still serving `other`, and `root` — now the configured one — is offered.
      expect(fixture.workspaces.roots()).toContain(fixture.other);
      expect(fixture.workspaces.roots()).toContain(fixture.root);
    });
  });
});

describe("WorkspaceManager.open", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;
  beforeEach(async () => {
    fixture = await tempWorkspace();
  });
  afterEach(() => fixture.cleanup());

  it("drops an unusable granted root rather than refusing to start", async () => {
    const manager = await WorkspaceManager.open(
      fixture.root,
      [path.join(fixture.outside, "missing"), fixture.other],
      silentLogger,
    );
    expect(manager.roots()).toEqual([fixture.root, fixture.other]);
  });

  it("still fails when the active root itself is unusable", async () => {
    await expect(
      WorkspaceManager.open(path.join(fixture.outside, "missing"), [], silentLogger),
    ).rejects.toThrow(/does not exist/);
  });
});

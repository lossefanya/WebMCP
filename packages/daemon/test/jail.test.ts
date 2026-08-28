import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JailViolation } from "../src/jail.js";
import { tempWorkspace } from "./helpers.js";

describe("Workspace jail", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;

  beforeEach(async () => {
    fixture = await tempWorkspace();
    await fsp.writeFile(path.join(fixture.root, "inside.txt"), "inside\n");
    await fsp.mkdir(path.join(fixture.root, "nested"));
    await fsp.writeFile(path.join(fixture.root, "nested", "deep.txt"), "deep\n");
    await fsp.writeFile(path.join(fixture.outside, "secret.txt"), "secret\n");
  });

  afterEach(() => fixture.cleanup());

  it("resolves a relative path inside the root", async () => {
    const jailed = await fixture.workspace.resolveExisting("nested/deep.txt");
    expect(jailed.display).toBe("nested/deep.txt");
    expect(jailed.real.startsWith(fixture.root)).toBe(true);
  });

  it("rejects a parent traversal", async () => {
    await expect(fixture.workspace.resolveExisting("../outside/secret.txt")).rejects.toThrow(
      JailViolation,
    );
  });

  it("rejects an absolute path outside the root", async () => {
    // Absolute paths are not automatically trusted just for being absolute.
    await expect(
      fixture.workspace.resolveExisting(path.join(fixture.outside, "secret.txt")),
    ).rejects.toThrow(/escapes the workspace|no such path/);
  });

  it("rejects a null byte", async () => {
    await expect(fixture.workspace.resolveExisting("inside.txt\0.png")).rejects.toThrow(
      /null byte/,
    );
  });

  it("follows a symlink and refuses it when it lands outside — the classic escape", async () => {
    // A prefix check on the raw string would pass this: the path starts with
    // the root. Only resolving first catches it.
    const link = path.join(fixture.root, "escape");
    await fsp.symlink(fixture.outside, link);

    await expect(fixture.workspace.resolveExisting("escape/secret.txt")).rejects.toThrow(
      /escapes the workspace/,
    );
    await expect(fixture.workspace.openRead("escape/secret.txt")).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  it("rejects a symlink to a single file outside the root", async () => {
    await fsp.symlink(path.join(fixture.outside, "secret.txt"), path.join(fixture.root, "peek.txt"));
    await expect(fixture.workspace.openRead("peek.txt")).rejects.toThrow(/escapes the workspace/);
  });

  it("allows a symlink that stays inside the root", async () => {
    await fsp.symlink(path.join(fixture.root, "nested", "deep.txt"), path.join(fixture.root, "alias.txt"));
    const { handle, path: jailed } = await fixture.workspace.openRead("alias.txt");
    try {
      // The jail reports where the bytes actually came from, not the alias.
      expect(jailed.display).toBe("nested/deep.txt");
      expect((await handle.readFile("utf8")).trim()).toBe("deep");
    } finally {
      await handle.close();
    }
  });

  it("refuses to write through a symlink, even one pointing inside", async () => {
    // The model asked for `alias.txt`; writing to whatever it points at is a
    // different action than the one being approved.
    await fsp.symlink(path.join(fixture.root, "inside.txt"), path.join(fixture.root, "alias.txt"));
    await expect(fixture.workspace.openWrite("alias.txt", "overwrite")).rejects.toThrow();
    expect((await fsp.readFile(path.join(fixture.root, "inside.txt"), "utf8")).trim()).toBe("inside");
  });

  it("refuses to write through a symlinked parent directory", async () => {
    await fsp.symlink(fixture.outside, path.join(fixture.root, "escape"));
    await expect(fixture.workspace.openWrite("escape/planted.txt", "overwrite")).rejects.toThrow(
      JailViolation,
    );
    await expect(fsp.stat(path.join(fixture.outside, "planted.txt"))).rejects.toThrow();
  });

  it("resolves a not-yet-existing path for create, inside the root", async () => {
    const jailed = await fixture.workspace.resolveForCreate("nested/new/file.txt");
    expect(jailed.display).toBe("nested/new/file.txt");
    expect(jailed.real.startsWith(fixture.root)).toBe(true);
  });

  it("rejects a create target that climbs out", async () => {
    await expect(fixture.workspace.resolveForCreate("../outside/planted.txt")).rejects.toThrow(
      JailViolation,
    );
    await expect(fixture.workspace.resolveForCreate("nested/../../outside/x.txt")).rejects.toThrow(
      JailViolation,
    );
  });

  it("writes and reads back inside the jail", async () => {
    const { handle, path: jailed, created } = await fixture.workspace.openWrite("new.txt", "create_new");
    try {
      expect(created).toBe(true);
      expect(jailed.display).toBe("new.txt");
      await handle.writeFile("written", "utf8");
    } finally {
      await handle.close();
    }
    expect(await fsp.readFile(path.join(fixture.root, "new.txt"), "utf8")).toBe("written");
  });

  it("refuses create_new on an existing file", async () => {
    await expect(fixture.workspace.openWrite("inside.txt", "create_new")).rejects.toThrow(
      /already exists/,
    );
  });

  it("refuses to read a directory as a file", async () => {
    await expect(fixture.workspace.openRead("nested")).rejects.toThrow(/not a regular file/);
  });

  it("treats the root itself as contained", () => {
    expect(fixture.workspace.contains(fixture.root)).toBe(true);
    expect(fixture.workspace.contains(path.join(fixture.root, "a", "b"))).toBe(true);
    expect(fixture.workspace.contains(fixture.outside)).toBe(false);
    // A sibling directory whose name merely starts with the root's name.
    expect(fixture.workspace.contains(`${fixture.root}-evil`)).toBe(false);
  });
});

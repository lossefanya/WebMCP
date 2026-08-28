import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The workspace jail. Every path that reaches the filesystem tools passes
 * through here, and nothing else in the daemon is allowed to call `fs` with a
 * caller-supplied path.
 *
 * Two rules, in this order, both of which have a well-known bypass if skipped:
 *
 *  1. Resolve symlinks *before* comparing against the root. Comparing the raw
 *     string first is the classic escape: `<root>/link` where `link -> /etc`
 *     passes a prefix check and then opens `/etc/passwd`.
 *  2. Re-check at use time. A path validated a millisecond ago can be a
 *     symlink out of the jail by the time it is opened (TOCTOU), so the tools
 *     take a file handle from here and never re-open by name.
 */
export class JailViolation extends Error {
  readonly code = "jail_violation";
  constructor(
    message: string,
    readonly requested: string,
  ) {
    super(message);
    this.name = "JailViolation";
  }
}

/** A path that has been proven to live inside the jail. */
export interface JailedPath {
  /** Absolute, fully symlink-resolved. */
  readonly real: string;
  /** Root-relative, POSIX separators — safe to show the model. */
  readonly display: string;
}

export class Workspace {
  private constructor(readonly root: string) {}

  /**
   * `root` is resolved once at startup. Nothing at runtime can move it — the
   * extension has no message that reaches this constructor.
   */
  static async open(root: string): Promise<Workspace> {
    const abs = path.resolve(root);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch (cause) {
      throw new Error(`workspace root does not exist: ${abs}`, { cause });
    }
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new Error(`workspace root is not a directory: ${real}`);
    return new Workspace(real);
  }

  /** True when `candidate` (already symlink-resolved) is the root or below it. */
  contains(candidate: string): boolean {
    if (candidate === this.root) return true;
    const rel = path.relative(this.root, candidate);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  private toDisplay(real: string): string {
    const rel = path.relative(this.root, real);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }

  /**
   * Resolve a path that must already exist. Relative paths are taken against
   * the root; absolute paths are allowed but must land inside it, so a caller
   * cannot smuggle `/etc/passwd` past a "it's absolute, so it's fine" reading.
   */
  async resolveExisting(requested: string): Promise<JailedPath> {
    const joined = this.join(requested);
    let real: string;
    try {
      real = await fs.realpath(joined);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code === "ENOENT") throw new JailViolation(`no such path: ${requested}`, requested);
      throw new JailViolation(`cannot resolve path: ${requested}`, requested);
    }
    this.assertContained(real, requested);
    return { real, display: this.toDisplay(real) };
  }

  /**
   * Resolve a path that may not exist yet (a write target). The deepest
   * existing ancestor is resolved and checked, then the remaining segments are
   * appended. Those segments are plain names by construction — `join` has
   * already collapsed any `..` — so they cannot climb back out.
   */
  async resolveForCreate(requested: string): Promise<JailedPath> {
    const joined = this.join(requested);
    const missing: string[] = [];
    let probe = joined;

    for (;;) {
      try {
        const real = await fs.realpath(probe);
        this.assertContained(real, requested);
        const target = missing.length ? path.join(real, ...missing) : real;
        // `real` is inside the jail and `missing` holds no `..`, so `target` is too.
        this.assertContained(target, requested);
        return { real: target, display: this.toDisplay(target) };
      } catch (cause) {
        if (cause instanceof JailViolation) throw cause;
        const err = cause as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw new JailViolation(`cannot resolve path: ${requested}`, requested);
        }
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw new JailViolation(`cannot resolve path: ${requested}`, requested);
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }

  /**
   * Open a file for reading and hand back the handle, having proven the thing
   * actually opened is the thing that was validated.
   *
   * `O_NOFOLLOW` stops the final component being swapped for a symlink after
   * the check. The dev/ino comparison catches a swap for a *hard* link or a
   * fresh file at the same name. Directory components in the middle of the
   * path remain a theoretical race — Node exposes no `openat`, so closing that
   * fully would need a native addon; an attacker would have to already be able
   * to write inside the jail to try it.
   */
  async openRead(requested: string): Promise<{ handle: fs.FileHandle; path: JailedPath; size: number }> {
    const jailed = await this.resolveExisting(requested);
    const before = await fs.lstat(jailed.real);
    if (before.isSymbolicLink()) {
      // realpath returned it, so this is a symlink created between the two calls.
      throw new JailViolation(`path changed while being validated: ${requested}`, requested);
    }
    if (!before.isFile()) throw new JailViolation(`not a regular file: ${jailed.display}`, requested);

    const handle = await fs.open(jailed.real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
        throw new JailViolation(`path changed while being opened: ${requested}`, requested);
      }
      // Cheap belt-and-braces: the name must still resolve into the jail.
      this.assertContained(await fs.realpath(jailed.real), requested);
      return { handle, path: jailed, size: after.size };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Open a file for writing.
   *
   * Writes are held to a stricter rule than reads: **the requested path must
   * contain no symlinks at all**, not merely resolve to somewhere inside the
   * jail. A read through a link is harmless and often what the user meant. A
   * write is not, because the human approved a prompt that said "write
   * alias.txt" — following the link would modify a different file than the one
   * they agreed to, while staying technically inside the workspace.
   *
   * `O_NOFOLLOW` then closes the window between that check and the open.
   */
  async openWrite(
    requested: string,
    mode: "overwrite" | "append" | "create_new",
  ): Promise<{ handle: fs.FileHandle; path: JailedPath; created: boolean }> {
    const jailed = await this.resolveForCreate(requested);

    // `join` only collapses `.`/`..`; it resolves no links. So if the literal
    // path and the resolved path differ, something along the way is a symlink.
    const literal = this.join(requested);
    if (literal !== jailed.real) {
      throw new JailViolation(
        `refusing to write through a symlink: ${requested} resolves to ${this.toDisplay(jailed.real)}`,
        requested,
      );
    }

    const parent = path.dirname(jailed.real);
    const parentReal = await fs.realpath(parent).catch(() => null);
    if (parentReal === null) {
      throw new JailViolation(`parent directory missing: ${jailed.display}`, requested);
    }
    this.assertContained(parentReal, requested);
    if (parentReal !== parent) {
      // A parent became a symlink between resolveForCreate and now.
      throw new JailViolation(`path changed while being validated: ${requested}`, requested);
    }

    const existed = await fs.lstat(jailed.real).then(
      () => true,
      () => false,
    );
    if (existed && mode === "create_new") {
      throw new JailViolation(`already exists: ${jailed.display}`, requested);
    }

    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_CREAT |
      (mode === "append" ? fsConstants.O_APPEND : fsConstants.O_TRUNC) |
      (mode === "create_new" ? fsConstants.O_EXCL : 0);

    const handle = await fs.open(jailed.real, flags, 0o644);
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new JailViolation(`not a regular file: ${jailed.display}`, requested);
      return { handle, path: jailed, created: !existed };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  }

  /** Join without letting `..` walk out, then hand the rest to realpath. */
  private join(requested: string): string {
    if (requested === "") return this.root;
    if (requested.includes("\0")) throw new JailViolation("path contains a null byte", requested);
    return path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(this.root, requested);
  }

  private assertContained(real: string, requested: string): void {
    if (!this.contains(real)) {
      throw new JailViolation(`path escapes the workspace: ${requested}`, requested);
    }
  }
}

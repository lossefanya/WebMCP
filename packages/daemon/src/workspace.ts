import * as path from "node:path";
import type { Logger } from "./log.js";
import { Workspace, isWithin } from "./jail.js";

/**
 * The live workspace root, and the set of roots it is allowed to become.
 *
 * A `Workspace` is immutable by design — it is the jail, and a jail that can be
 * moved by whoever it contains is not one. So switching roots means building a
 * new `Workspace` and swapping the reference here, under one rule:
 *
 *   **the daemon only ever moves to a root a human wrote in the config file.**
 *
 * `grantable` is read from `.webmcp/config.json` at startup and on reload.
 * Nothing that arrives over the socket can add to it — `switchTo` is a
 * *selection* from a list, never a widening of it. That keeps the invariant the
 * whole product rests on: the extension is a transport, and no message from the
 * page can enlarge what the tools may touch.
 *
 * Narrowing is allowed: a subdirectory of a grantable root is strictly less
 * reach than the root itself, so it needs no separate grant.
 */
export class WorkspaceRefused extends Error {
  readonly code = "workspace_refused";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRefused";
  }
}

type Listener = (workspace: Workspace) => void;

export class WorkspaceManager {
  private workspace: Workspace;
  /** Real, symlink-resolved paths. Resolved once so `switchTo` compares like with like. */
  private grantable: string[];
  private readonly listeners = new Set<Listener>();

  /** The `workspace` value as of the last config read, so `reload` can spot a real change. */
  private configuredActive: string;

  private constructor(
    workspace: Workspace,
    grantable: string[],
    private readonly log: Logger,
  ) {
    this.workspace = workspace;
    this.grantable = grantable;
    this.configuredActive = workspace.root;
  }

  /**
   * `active` is the starting root; `declared` is the switchable set from the
   * config. A declared root that does not exist is dropped with a warning
   * rather than failing startup — a stale entry for an unmounted disk should
   * not stop the daemon serving the root that does exist.
   */
  static async open(active: string, declared: string[], log: Logger): Promise<WorkspaceManager> {
    const workspace = await Workspace.open(active);
    const roots = [workspace.root];
    for (const candidate of declared) {
      try {
        const opened = await Workspace.open(candidate);
        if (!roots.includes(opened.root)) roots.push(opened.root);
      } catch (err) {
        log.warn(`workspace: ignoring unusable root ${candidate}: ${(err as Error).message}`);
      }
    }
    return new WorkspaceManager(workspace, roots, log);
  }

  /** The jail as of right now. Read it per call — never cache it across an await. */
  get current(): Workspace {
    return this.workspace;
  }

  get root(): string {
    return this.workspace.root;
  }

  /** What `set_workspace` will accept, active root first. */
  roots(): string[] {
    return [this.root, ...this.grantable.filter((r) => r !== this.root)];
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Move to `requested`, which must be a grantable root or inside one.
   *
   * In-flight calls are deliberately left alone. Each one captured its
   * `Workspace` in its `ToolContext` when it started, so it finishes against
   * the root it was authorized under — a call the user approved for project A
   * must not land in project B because a switch happened while it ran.
   */
  async switchTo(requested: string): Promise<Workspace> {
    if (typeof requested !== "string" || requested.length === 0) {
      throw new WorkspaceRefused("no workspace root given");
    }
    if (requested.includes("\0")) throw new WorkspaceRefused("path contains a null byte");

    let next: Workspace;
    try {
      // Resolves symlinks, so the containment check below compares real paths.
      // Checking the requested string against the grantable list before
      // resolution is the same mistake the jail refuses to make.
      next = await Workspace.open(path.resolve(requested));
    } catch (err) {
      throw new WorkspaceRefused(`cannot use that directory: ${(err as Error).message}`);
    }

    if (!this.grantable.some((root) => isWithin(root, next.root))) {
      // Deliberately does not echo the grantable list back: the caller is told
      // its request was refused, not walked around the user's disk.
      throw new WorkspaceRefused(
        `${next.root} is not one of the workspaces granted in the daemon config`,
      );
    }

    if (next.root === this.workspace.root) return this.workspace;

    const previous = this.workspace.root;
    this.workspace = next;
    this.log.audit(`workspace: ${previous} -> ${next.root}`);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  /**
   * Apply a re-read config. Called by the config watcher and on SIGHUP, so the
   * terminal stays the way a *new* root is granted: the file is the authority,
   * and this is the daemon noticing the file changed.
   *
   * The active root moves only when the config's `workspace` value itself
   * changed. Touching the file for an unrelated reason — adding an MCP server —
   * must not yank the user back out of a root they picked in the popup, so the
   * last value read is remembered and compared against.
   */
  async reload(active: string, declared: string[]): Promise<boolean> {
    const roots: string[] = [];
    let resolvedActive: string | null = null;
    for (const candidate of [active, ...declared]) {
      try {
        const opened = await Workspace.open(candidate);
        resolvedActive ??= opened.root;
        if (!roots.includes(opened.root)) roots.push(opened.root);
      } catch (err) {
        this.log.warn(`workspace: ignoring unusable root ${candidate}: ${(err as Error).message}`);
      }
    }
    if (roots.length === 0) {
      this.log.warn("workspace: reloaded config named no usable root — keeping the current one");
      return false;
    }

    const next = roots.includes(this.workspace.root) ? roots : [...roots, this.workspace.root];
    // The *set* changing matters on its own, not only the active root moving.
    // Granting a second directory leaves the current one exactly where it was,
    // and if that goes unannounced every already-connected popup keeps showing
    // a stale list until it happens to reconnect — which is indistinguishable
    // from the grant not having worked.
    const grantableChanged =
      next.length !== this.grantable.length || next.some((r) => !this.grantable.includes(r));
    this.grantable = next;

    // Narrowed to a string so the move below needs no re-check.
    const moveTo =
      resolvedActive !== null &&
      resolvedActive !== this.configuredActive &&
      resolvedActive !== this.workspace.root
        ? resolvedActive
        : null;
    if (resolvedActive !== null) this.configuredActive = resolvedActive;

    const moved = moveTo !== null;
    if (moveTo !== null) {
      const previous = this.workspace.root;
      this.workspace = await Workspace.open(moveTo);
      this.log.audit(`workspace: ${previous} -> ${this.workspace.root} (config reload)`);
    } else if (grantableChanged) {
      this.log.audit(`workspace: switchable roots now ${this.grantable.join(", ")}`);
    }

    if (moved || grantableChanged) {
      for (const listener of this.listeners) listener(this.workspace);
    }
    return moved;
  }
}

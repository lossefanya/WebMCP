import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDescriptor } from "@webmcp/protocol";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type { WorkspaceManager } from "./workspace.js";

/**
 * Who has to say yes before a call runs.
 *
 * Reads inside the jail are auto-approved: the jail is the grant, and a prompt
 * per file read would train the user to click through everything. Anything that
 * changes state or leaves the machine needs a human, unless that human has
 * previously chosen "always" for this exact shape.
 *
 * This lives in the daemon and only in the daemon. There is no message the
 * extension can send that adds an entry here — `allowAlways` is reachable only
 * from an approval whose nonce the daemon itself minted.
 *
 * **Rules are scoped to the workspace root they were granted in.** The button
 * has always said "Always allow `git` in *my-project*", so carrying that grant
 * into a different root once the workspace can move at runtime would be the
 * daemon quietly doing something other than what the user read and clicked.
 * Switching back restores it; the rule was never revoked, only out of scope.
 */
export type Decision = "auto" | "needs_approval";

export interface AllowRule {
  key: string;
  /** Workspace root this rule was granted in. Absent in files written before scoping. */
  root?: string;
  label: string;
  addedAt: string;
}

export class Policy {
  private rules = new Map<string, AllowRule>();
  private readonly file: string;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    /** Live root. Omitted in tests and by callers with a fixed workspace. */
    private readonly workspaces?: WorkspaceManager,
  ) {
    this.file = path.join(config.stateDir, "allowlist.json");
  }

  private get root(): string {
    return this.workspaces?.root ?? this.config.workspace;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      const entries = Array.isArray((raw as { rules?: unknown }).rules)
        ? ((raw as { rules: unknown[] }).rules as AllowRule[])
        : [];
      let unscoped = 0;
      for (const rule of entries) {
        if (typeof rule?.key !== "string") continue;
        // A rule with no root predates scoping, so there is no way to know which
        // workspace its human was looking at. Dropping it fails closed: the
        // worst case is one more approval prompt, where the alternative is a
        // standing grant applied to a directory nobody agreed to.
        if (typeof rule.root !== "string") {
          unscoped++;
          continue;
        }
        this.rules.set(scopedKey(rule.root, rule.key), rule);
      }
      if (unscoped > 0) {
        this.log.warn(
          `policy: dropped ${unscoped} standing rule(s) with no workspace recorded — approve them again when prompted`,
        );
      }
      this.log.info(`policy: ${this.rules.size} standing allow rule(s)`);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") this.log.warn(`policy: ignoring unreadable ${this.file}`);
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ rules: [...this.rules.values()] }, null, 2);
    await fs.writeFile(this.file, body, { encoding: "utf8", mode: 0o600 });
  }

  /**
   * `root` defaults to the live one, but a caller sequencing an approval must
   * pass the root that call started under: the workspace can move while a
   * prompt is open, and the answer has to belong to the directory named on the
   * prompt the human actually read.
   */
  decide(descriptor: ToolDescriptor, args: Record<string, unknown>, root = this.root): Decision {
    if (descriptor.risk === "read") return "auto";
    return this.rules.has(scopedKey(root, allowKey(descriptor, args))) ? "auto" : "needs_approval";
  }

  async allowAlways(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    root = this.root,
  ): Promise<void> {
    const key = allowKey(descriptor, args);
    const label = allowLabel(descriptor, args, root);
    this.rules.set(scopedKey(root, key), { key, root, label, addedAt: new Date().toISOString() });
    await this.save();
    this.log.audit(`policy: standing allow added — ${label} (${root})`);
  }

  /** Rules in force for the current root — what the startup banner counts. */
  list(): AllowRule[] {
    const root = this.root;
    return [...this.rules.values()].filter((rule) => rule.root === root);
  }

  listAll(): AllowRule[] {
    return [...this.rules.values()];
  }

  async revoke(key: string, root = this.root): Promise<boolean> {
    if (!this.rules.delete(scopedKey(root, key))) return false;
    await this.save();
    this.log.audit(`policy: standing allow revoked — ${key} (${root})`);
    return true;
  }

  /** Label shown on the "always allow" button, or undefined when it makes no sense. */
  alwaysLabel(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    root = this.root,
  ): string | undefined {
    if (descriptor.risk === "read") return undefined;
    return allowLabel(descriptor, args, root);
  }
}

/**
 * The granularity of "always allow". Deliberately coarse where the jail already
 * bounds the damage (any write inside the workspace) and fine where it does not
 * (one binary at a time for exec, one tool at a time for a network server).
 */
export function allowKey(descriptor: ToolDescriptor, args: Record<string, unknown>): string {
  if (descriptor.name === "exec_run") {
    const command = typeof args.command === "string" ? args.command : "?";
    return `exec_run:${command}`;
  }
  return descriptor.name;
}

/**
 * Storage key. A NUL separator because it is the one byte a path cannot
 * contain, so no root and tool name can be concatenated two different ways.
 */
export function scopedKey(root: string, key: string): string {
  return `${root}\0${key}`;
}

function allowLabel(
  descriptor: ToolDescriptor,
  args: Record<string, unknown>,
  workspace: string,
): string {
  if (descriptor.name === "exec_run") {
    return `Always allow \`${String(args.command)}\` in ${path.basename(workspace)}`;
  }
  if (descriptor.server) {
    return `Always allow ${descriptor.name} (${descriptor.server})`;
  }
  return `Always allow ${descriptor.name} in ${path.basename(workspace)}`;
}

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

/**
 * Binaries that may never carry a standing allow.
 *
 * The exec allowlist is a coarse filter, not a containment boundary: `cwd` is
 * the workspace but arguments are never path-checked, and every binary here can
 * run code of its own choosing —
 *
 *   node -e / python3 -c        arbitrary code, straight away
 *   npm / npx                   lifecycle scripts, and fetches code off the network
 *   make                        shell commands from a Makefile `fs_write` can create
 *   awk 'BEGIN{system("…")}'    documented shell escape
 *   find -exec                  runs any binary, allowlist or not
 *   sed -i                      writes to any absolute path (GNU sed also has `e`)
 *   git -c alias.x='!sh …'      alias and hook execution
 *
 * Each was verified escaping a live jail, not assumed. Per-call approval shows
 * the human the exact argv, which is a real check. A standing allow does not:
 * `allowKey` is keyed on the binary with no constraint on arguments, so
 * approving `node -e "console.log(1)"` with **Always** would silently authorise
 * every later `node -e <anything>`. Against a threat model whose first line is
 * "the page is hostile", that converts one reasonable-looking click into
 * unattended arbitrary code execution.
 *
 * So these stay per-call forever. The button is not offered, and the daemon
 * refuses to record the rule even if a decision arrives claiming otherwise —
 * the extension renders prompts, it does not decide what may be remembered.
 */
const NO_STANDING_ALLOW = new Set([
  "node",
  "npm",
  "npx",
  "python3",
  "python",
  "make",
  "awk",
  "find",
  "sed",
  "git",
  "perl",
  "ruby",
  "bash",
  "sh",
  "zsh",
  "env",
  "xargs",
]);

/**
 * Whether this call shape may ever be remembered. Read risk is excluded because
 * it is auto-approved anyway and never reaches an approval prompt.
 */
export function canAllowAlways(descriptor: ToolDescriptor, args: Record<string, unknown>): boolean {
  if (descriptor.risk === "read") return false;
  if (descriptor.name !== "exec_run") return true;
  const command = typeof args.command === "string" ? args.command : "";
  return !NO_STANDING_ALLOW.has(command);
}

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
      const revoked: string[] = [];
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
        // A rule saved before this binary was restricted is exactly the standing
        // grant the restriction exists to remove, so dropping it on load is the
        // whole point — leaving it would protect only users who never clicked.
        const binary = rule.key.startsWith("exec_run:") ? rule.key.slice("exec_run:".length) : null;
        if (binary !== null && NO_STANDING_ALLOW.has(binary)) {
          revoked.push(binary);
          continue;
        }
        this.rules.set(scopedKey(rule.root, rule.key), rule);
      }
      if (revoked.length > 0) {
        this.log.warn(
          `policy: dropped standing allow(s) for ${[...new Set(revoked)].join(", ")} — these can run arbitrary code, so they are asked about every time`,
        );
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
    // Enforcement, not just a hidden button. The label being absent stops the
    // popup offering it; this stops a decision that claims "always" anyway from
    // being remembered. The call still runs — a human did approve it — it is
    // only the standing grant that is refused.
    if (!canAllowAlways(descriptor, args)) {
      this.log.audit(
        `policy: refused a standing allow for ${descriptor.name}` +
          (descriptor.name === "exec_run" ? ` ${String(args.command)}` : "") +
          " — it can run arbitrary code, so it is asked about every time",
      );
      return;
    }
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
    if (!canAllowAlways(descriptor, args)) return undefined;
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

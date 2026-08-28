import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDescriptor } from "@webmcp/protocol";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

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
 */
export type Decision = "auto" | "needs_approval";

export interface AllowRule {
  key: string;
  label: string;
  addedAt: string;
}

export class Policy {
  private rules = new Map<string, AllowRule>();
  private readonly file: string;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.file = path.join(config.stateDir, "allowlist.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      const entries = Array.isArray((raw as { rules?: unknown }).rules)
        ? ((raw as { rules: unknown[] }).rules as AllowRule[])
        : [];
      for (const rule of entries) {
        if (typeof rule?.key === "string") this.rules.set(rule.key, rule);
      }
      this.log.info(`policy: ${this.rules.size} standing allow rule(s)`);
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") this.log.warn(`policy: ignoring unreadable ${this.file}`);
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const body = JSON.stringify({ rules: [...this.rules.values()] }, null, 2);
    await fs.writeFile(this.file, body, { encoding: "utf8", mode: 0o600 });
  }

  decide(descriptor: ToolDescriptor, args: Record<string, unknown>): Decision {
    if (descriptor.risk === "read") return "auto";
    return this.rules.has(allowKey(descriptor, args)) ? "auto" : "needs_approval";
  }

  async allowAlways(descriptor: ToolDescriptor, args: Record<string, unknown>): Promise<void> {
    const key = allowKey(descriptor, args);
    const label = allowLabel(descriptor, args, this.config.workspace);
    this.rules.set(key, { key, label, addedAt: new Date().toISOString() });
    await this.save();
    this.log.audit(`policy: standing allow added — ${label}`);
  }

  list(): AllowRule[] {
    return [...this.rules.values()];
  }

  async revoke(key: string): Promise<boolean> {
    if (!this.rules.delete(key)) return false;
    await this.save();
    this.log.audit(`policy: standing allow revoked — ${key}`);
    return true;
  }

  /** Label shown on the "always allow" button, or undefined when it makes no sense. */
  alwaysLabel(descriptor: ToolDescriptor, args: Record<string, unknown>): string | undefined {
    if (descriptor.risk === "read") return undefined;
    return allowLabel(descriptor, args, this.config.workspace);
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

import { type ToolDescriptor, type ToolResult, splitToolName } from "@webmcp/protocol";
import type { Config } from "./config.js";
import type { Workspace } from "./jail.js";
import type { Logger } from "./log.js";
import type { McpManager } from "./mcp/manager.js";
import { execTools } from "./tools/exec.js";
import { fsTools } from "./tools/fs.js";
import { type Tool, ToolError, type ToolContext } from "./tools/types.js";

/**
 * One flat tool list, built-ins and proxied MCP tools together — which is all
 * the extension ever sees. Built-ins are un-namespaced (`fs_read`); downstream
 * tools carry their server as a prefix (`notion__search`) so two servers cannot
 * collide, and the prefix is stripped again on the way out.
 */
export class Registry {
  private readonly builtins = new Map<string, Tool>();

  constructor(
    private readonly workspace: Workspace,
    private readonly config: Config,
    private readonly mcp: McpManager,
    private readonly log: Logger,
  ) {
    for (const tool of [...fsTools, ...execTools]) {
      if (tool.descriptor.name.includes("__")) {
        throw new Error(`built-in tool ${tool.descriptor.name} must not contain the namespace separator`);
      }
      this.builtins.set(tool.descriptor.name, tool);
    }
    // Exec vanishes from the list entirely when the allowlist is empty, rather
    // than being advertised and then always refused.
    if (this.config.exec.allow.length === 0) {
      this.builtins.delete("exec_run");
      this.log.info("registry: exec_run withheld — allowlist is empty");
    }
  }

  list(): ToolDescriptor[] {
    const builtin = [...this.builtins.values()].map((t) => t.descriptor);
    // Built-ins first: they are the ones that always work, and a downstream
    // outage must never reorder or remove them.
    return [...builtin, ...this.mcp.tools()];
  }

  describe(name: string): ToolDescriptor | undefined {
    return this.builtins.get(name)?.descriptor ?? this.mcp.find(name);
  }

  /** One-line rendering for the approval prompt. */
  summarize(name: string, args: Record<string, unknown>): string {
    const builtin = this.builtins.get(name);
    if (builtin) return builtin.summarize(args);
    const { server, tool } = splitToolName(name);
    return `Call ${tool} on ${server}`;
  }

  /**
   * Everything that can be refused without side effects, refused before a human
   * is asked. Unknown downstream tools are the only thing checked here for
   * proxied calls — the daemon does not re-implement each server's schema.
   */
  validate(name: string, args: Record<string, unknown>): void {
    const builtin = this.builtins.get(name);
    if (builtin?.validate) {
      builtin.validate(args, { workspace: this.workspace, config: this.config });
    }
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    origin: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const builtin = this.builtins.get(name);
    if (builtin) {
      const ctx: ToolContext = {
        workspace: this.workspace,
        config: this.config,
        origin,
        signal,
      };
      return builtin.run(args, ctx);
    }

    const descriptor = this.mcp.find(name);
    if (!descriptor?.server) {
      throw new ToolError(`unknown tool "${name}"`, "unknown_tool");
    }
    const { tool } = splitToolName(name);
    return this.mcp.call(descriptor.server, tool, args, signal);
  }
}

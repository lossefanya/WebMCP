import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ServerStatus,
  type ToolDescriptor,
  type ToolResult,
  type JsonSchema,
  namespaceToolName,
} from "@webmcp/protocol";
import type { Config, McpServerConfig } from "../config.js";
import type { Logger } from "../log.js";

/**
 * A downstream MCP server, connected as a client.
 *
 * Failure is the normal case here — a stdio server whose `npx` package moved,
 * an HTTP server that is down — so nothing in this class is allowed to throw
 * into the connect path. A broken server becomes a status and disappears from
 * the tool list; it never stops the built-in local tools from being served.
 */
class DownstreamServer {
  state: ServerStatus["state"] = "connecting";
  error: string | undefined;
  tools = new Map<string, ToolDescriptor>();

  private client: Client | undefined;
  private closed = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = 1_000;

  constructor(
    readonly id: string,
    private readonly cfg: McpServerConfig,
    private readonly log: Logger,
    private readonly onChange: () => void,
  ) {}

  status(): ServerStatus {
    return {
      id: this.id,
      state: this.state,
      toolCount: this.tools.size,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    this.state = "connecting";
    this.error = undefined;

    try {
      const client = new Client(
        { name: "webmcp", version: "0.0.1" },
        { capabilities: {} },
      );
      client.onerror = (err) => this.log.warn(`mcp:${this.id} ${err.message}`);
      client.onclose = () => this.handleDrop("connection closed");

      await client.connect(this.buildTransport());
      const listed = await client.listTools();

      this.client = client;
      this.tools.clear();
      for (const tool of listed.tools) {
        const name = namespaceToolName(this.id, tool.name);
        this.tools.set(name, {
          name,
          description: tool.description ?? `${tool.name} (${this.id})`,
          inputSchema: (tool.inputSchema ?? { type: "object" }) as JsonSchema,
          // Downstream servers are outside the workspace jail by nature, so a
          // non-read tool is treated as reaching the network until proven
          // otherwise by the server's own annotations.
          risk: tool.annotations?.readOnlyHint === true ? "read" : "network",
          server: this.id,
        });
      }

      this.state = "connected";
      this.retryDelayMs = 1_000;
      this.log.info(`mcp:${this.id} connected, ${this.tools.size} tool(s)`);
    } catch (cause) {
      this.handleDrop(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    this.onChange();
  }

  private buildTransport() {
    if (this.cfg.url) {
      return new StreamableHTTPClientTransport(new URL(this.cfg.url));
    }
    if (!this.cfg.command) throw new Error("neither command nor url configured");
    return new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      // The server's own env, plus whatever the user configured for it. This is
      // outside the jail on purpose: a Notion server needs its API token.
      env: { ...inheritedEnv(), ...(this.cfg.env ?? {}) },
      stderr: "pipe",
    });
  }

  private handleDrop(reason: string): void {
    if (this.closed) return;
    const wasConnected = this.state === "connected";
    this.client = undefined;
    this.tools.clear();
    this.state = "failed";
    this.error = reason;
    if (wasConnected) this.log.warn(`mcp:${this.id} dropped: ${reason}`);
    else this.log.warn(`mcp:${this.id} unavailable: ${reason}`);
    this.onChange();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Namespaced tool name in, unnamespaced call out. */
  async call(
    unnamespaced: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const client = this.client;
    if (!client || this.state !== "connected") {
      throw new ServerUnavailable(this.id, this.error ?? "not connected");
    }
    const raw = await client.callTool({ name: unnamespaced, arguments: args }, undefined, {
      timeout: timeoutMs,
      signal,
    });

    // Flatten to text: the result is going to be pasted into a chat message.
    const content = (Array.isArray(raw.content) ? raw.content : []).map((part) => {
      const p = part as { type?: string; text?: string; mimeType?: string };
      if (p.type === "text") return { type: "text" as const, text: p.text ?? "" };
      return { type: "text" as const, text: `[${p.type ?? "unknown"} content omitted]` };
    });
    return { content, isError: raw.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    this.state = "disabled";
    await client?.close().catch(() => {});
  }
}

export class ServerUnavailable extends Error {
  readonly code = "server_unavailable";
  constructor(
    readonly serverId: string,
    reason: string,
  ) {
    super(`MCP server "${serverId}" is unavailable: ${reason}`);
    this.name = "ServerUnavailable";
  }
}

export class McpManager {
  private readonly servers = new Map<string, DownstreamServer>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    for (const [id, cfg] of Object.entries(config.mcpServers)) {
      if (cfg.disabled) {
        this.log.info(`mcp:${id} disabled in config`);
        continue;
      }
      this.servers.set(id, new DownstreamServer(id, cfg, log, () => this.emit()));
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Kick off every connection and return immediately. Waiting here would mean a
   * single slow `npx` install delays the whole daemon coming up.
   */
  start(): void {
    for (const server of this.servers.values()) void server.connect();
  }

  statuses(): ServerStatus[] {
    return [...this.servers.values()].map((s) => s.status());
  }

  tools(): ToolDescriptor[] {
    return [...this.servers.values()].flatMap((s) => [...s.tools.values()]);
  }

  find(namespaced: string): ToolDescriptor | undefined {
    for (const server of this.servers.values()) {
      const found = server.tools.get(namespaced);
      if (found) return found;
    }
    return undefined;
  }

  async call(
    serverId: string,
    unnamespaced: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const server = this.servers.get(serverId);
    if (!server) throw new ServerUnavailable(serverId, "not configured");
    return server.call(unnamespaced, args, this.config.limits.downstreamTimeoutMs, signal);
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => s.close()));
  }
}

/** Same spirit as the exec tool: hand a child only what it plausibly needs. */
function inheritedEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "APPDATA", "SystemRoot"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

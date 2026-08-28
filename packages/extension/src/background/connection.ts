import {
  type ApprovalRequestMessage,
  type ClientMessage,
  type ServerStatus,
  type ServerToClientMessage,
  type ToolDescriptor,
  type ToolResult,
  WIRE_VERSION,
} from "@webmcp/protocol";
import type { Pairing } from "./store.js";

/**
 * The daemon connection. The one place in the extension that holds the token
 * and speaks the wire protocol.
 *
 * Deliberately dumb about authorization: it forwards calls and renders whatever
 * the daemon asks for. It has no allowlist, no workspace root, and no way to
 * approve anything — those live in the daemon, so a bug in this file cannot
 * widen what the daemon will run.
 */
export type ConnectionState = "idle" | "connecting" | "ready" | "failed";

export interface ConnectionEvents {
  onStateChange(): void;
  onApprovalRequest(request: ApprovalRequestMessage): void;
}

interface Waiter {
  resolve(result: ToolResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ceiling on a single call, so a wedged daemon does not leave a promise open forever. */
const CALL_TIMEOUT_MS = 180_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class DaemonConnection {
  state: ConnectionState = "idle";
  workspace: string | null = null;
  /** Roots the daemon will switch between. Reported by it; never assembled here. */
  workspaceRoots: string[] = [];
  tools: ToolDescriptor[] = [];
  servers: ServerStatus[] = [];
  lastError: string | null = null;

  private socket: WebSocket | undefined;
  private pairing: Pairing | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly workspaceWaiters = new Map<string, { resolve(root: string): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly toolWaiters = new Set<(tools: ToolDescriptor[]) => void>();
  private nextId = 1;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUs = false;

  constructor(private readonly events: ConnectionEvents) {}

  get connected(): boolean {
    return this.state === "ready";
  }

  connect(pairing: Pairing): void {
    this.pairing = pairing;
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.pairing = undefined;
    this.failAll("disconnected");
    this.socket?.close(1000, "unpaired");
    this.socket = undefined;
    this.state = "idle";
    this.workspace = null;
    this.workspaceRoots = [];
    this.tools = [];
    this.servers = [];
    this.events.onStateChange();
  }

  /** Called from the keepalive alarm, and after a service-worker wake. */
  ensureConnected(): void {
    if (this.closedByUs || !this.pairing) return;
    if (this.socket && (this.state === "ready" || this.state === "connecting")) return;
    this.open();
  }

  private open(): void {
    const pairing = this.pairing;
    if (!pairing) return;

    this.state = "connecting";
    this.lastError = null;
    this.events.onStateChange();

    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${pairing.port}`);
    } catch (err) {
      this.handleClose(`cannot open socket: ${(err as Error).message}`);
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.send({
        kind: "hello",
        version: WIRE_VERSION,
        token: pairing.token,
        client: `webmcp-extension ${chrome.runtime.getManifest().version}`,
      });
    });

    socket.addEventListener("message", (event) => {
      let message: ServerToClientMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerToClientMessage;
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    socket.addEventListener("close", (event) => {
      this.handleClose(
        event.code === 4401
          ? "the daemon rejected the pairing token"
          : event.reason || `connection closed (${event.code})`,
      );
    });

    socket.addEventListener("error", () => {
      // `error` carries no detail in a worker; `close` follows with the reason.
      this.lastError ??= "socket error";
    });
  }

  private handleMessage(message: ServerToClientMessage): void {
    switch (message.kind) {
      case "ready":
        this.state = "ready";
        this.workspace = message.workspace;
        this.workspaceRoots = message.roots ?? [];
        this.servers = message.servers;
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.refreshTools();
        this.events.onStateChange();
        return;

      case "tools":
        this.tools = message.tools;
        for (const waiter of this.toolWaiters) waiter(message.tools);
        this.toolWaiters.clear();
        this.events.onStateChange();
        return;

      case "tools_changed":
        this.servers = message.servers;
        this.refreshTools();
        this.events.onStateChange();
        return;

      case "workspace_changed": {
        this.workspace = message.workspace;
        this.workspaceRoots = message.roots;
        // Broadcast, so it arrives with no id when another tab did the moving.
        if (message.id !== undefined) {
          const waiter = this.workspaceWaiters.get(message.id);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.workspaceWaiters.delete(message.id);
            waiter.resolve(message.workspace);
          }
        }
        this.events.onStateChange();
        return;
      }

      case "result": {
        const waiter = this.waiters.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(message.id);
        waiter.resolve(message.result);
        return;
      }

      case "approval_request":
        this.events.onApprovalRequest(message);
        return;

      case "error": {
        if (message.code === "unauthorized" || message.code === "version_mismatch") {
          this.lastError = message.message;
          this.events.onStateChange();
        }
        if (message.id === undefined) return;
        const pendingSwitch = this.workspaceWaiters.get(message.id);
        if (pendingSwitch) {
          clearTimeout(pendingSwitch.timer);
          this.workspaceWaiters.delete(message.id);
          pendingSwitch.reject(new Error(message.message));
          return;
        }
        const waiter = this.waiters.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(message.id);
        waiter.reject(new Error(message.message));
        return;
      }
    }
  }

  private handleClose(reason: string): void {
    this.socket = undefined;
    this.state = this.closedByUs ? "idle" : "failed";
    this.lastError = reason;
    this.failAll(reason);
    this.events.onStateChange();
    if (!this.closedByUs) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.pairing) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private failAll(reason: string): void {
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.waiters.clear();
    for (const [, waiter] of this.workspaceWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.workspaceWaiters.clear();
    this.toolWaiters.clear();
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("not connected to the daemon");
    this.socket.send(JSON.stringify(message));
  }

  private refreshTools(): void {
    try {
      this.send({ kind: "list_tools", id: `t${this.nextId++}` });
    } catch {
      /* the close handler already reported it */
    }
  }

  listTools(): Promise<ToolDescriptor[]> {
    if (this.tools.length) return Promise.resolve(this.tools);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.toolWaiters.delete(resolve);
        reject(new Error("timed out waiting for the tool list"));
      }, 10_000);
      const wrapped = (tools: ToolDescriptor[]) => {
        clearTimeout(timer);
        resolve(tools);
      };
      this.toolWaiters.add(wrapped);
      this.refreshTools();
    });
  }

  callTool(name: string, args: Record<string, unknown>, origin: string): Promise<ToolResult> {
    const id = `c${this.nextId++}`;
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        try {
          this.send({ kind: "cancel", id });
        } catch {
          /* already gone */
        }
        reject(new Error("the tool call timed out"));
      }, CALL_TIMEOUT_MS);

      this.waiters.set(id, { resolve, reject, timer });
      try {
        this.send({ kind: "call_tool", id, name, args, origin });
      } catch (err) {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(err as Error);
      }
    });
  }

  /**
   * Ask the daemon to move to `root`.
   *
   * Relay only, exactly like an approval: the daemon decides whether `root` is
   * one it was granted, and refuses otherwise. Nothing here filters or widens —
   * this class holding the socket must not also hold an opinion about which
   * directories are allowed, or a bug in it becomes a security bug.
   */
  setWorkspace(root: string): Promise<string> {
    const id = `w${this.nextId++}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workspaceWaiters.delete(id);
        reject(new Error("the daemon did not answer"));
      }, 10_000);
      this.workspaceWaiters.set(id, { resolve, reject, timer });
      try {
        this.send({ kind: "set_workspace", id, root });
      } catch (err) {
        clearTimeout(timer);
        this.workspaceWaiters.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Relay a human's click. The daemon validates the nonce; we never mint one. */
  respondToApproval(nonce: string, decision: "allow_once" | "allow_always" | "deny"): void {
    this.send({ kind: "approval_response", nonce, decision });
  }
}

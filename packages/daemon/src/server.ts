import type { IncomingMessage } from "node:http";
import {
  type ApprovalResponseMessage,
  type CallToolMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerToClientMessage,
  WIRE_VERSION,
} from "@webmcp/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { ApprovalBroker } from "./approvals.js";
import type { Config } from "./config.js";
import { JailViolation } from "./jail.js";
import type { Logger } from "./log.js";
import type { McpManager } from "./mcp/manager.js";
import type { Policy } from "./policy.js";
import type { Registry } from "./registry.js";
import { ToolError } from "./tools/types.js";
import { tokenMatches } from "./token.js";
import { ServerUnavailable } from "./mcp/manager.js";
import { WorkspaceRefused, type WorkspaceManager } from "./workspace.js";

/** A frame bigger than this is not a tool call, it is an attempt to exhaust memory. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** How long a socket may stay silent before presenting its token. */
const HELLO_TIMEOUT_MS = 5_000;
/** Concurrent in-flight calls per connection. */
const MAX_INFLIGHT = 8;

export interface DaemonServerDeps {
  config: Config;
  workspaces: WorkspaceManager;
  registry: Registry;
  policy: Policy;
  mcp: McpManager;
  token: string;
  log: Logger;
}

export class DaemonServer {
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Set<Session>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: DaemonServerDeps) {}

  async listen(): Promise<number> {
    const wss = new WebSocketServer({
      // Loopback only. Binding 0.0.0.0 would put shell execution on the LAN.
      host: "127.0.0.1",
      port: this.deps.config.port,
      maxPayload: MAX_FRAME_BYTES,
      verifyClient: (info, done) => this.verifyClient(info.req, done),
    });
    this.wss = wss;

    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });

    wss.on("connection", (socket, req) => {
      const session = new Session(socket, req, this.deps, () => this.sessions.delete(session));
      this.sessions.add(session);
    });

    const stopWatchingMcp = this.deps.mcp.onChange(() => {
      const servers = this.deps.mcp.statuses();
      for (const session of this.sessions) session.send({ kind: "tools_changed", servers });
    });
    // Every session hears about a move, not just the one that asked for it — a
    // second tab showing the old root is a lie about what the tools can reach,
    // and the daemon can also move itself when its config file changes.
    const stopWatchingWorkspace = this.deps.workspaces.onChange((workspace) => {
      const roots = this.deps.workspaces.roots();
      for (const session of this.sessions) {
        session.send({ kind: "workspace_changed", workspace: workspace.root, roots });
      }
    });
    this.unsubscribe = () => {
      stopWatchingMcp();
      stopWatchingWorkspace();
    };

    const address = wss.address();
    return typeof address === "object" && address !== null ? address.port : this.deps.config.port;
  }

  /**
   * Cheap pre-token filter. A browser is required to send a real `Origin` on a
   * WebSocket handshake from page context, so an `http(s)` origin here means a
   * web page is dialling the daemon directly — refuse it before it can even
   * guess at the token. This is defence in depth and nothing more: a native
   * process sends no Origin at all, which is why the token check below is the
   * one that actually decides.
   */
  private verifyClient(req: IncomingMessage, done: (ok: boolean, code?: number, msg?: string) => void): void {
    const origin = req.headers.origin;
    if (typeof origin === "string" && /^https?:\/\//i.test(origin)) {
      this.deps.log.warn(`refused web-page connection from origin ${origin}`);
      done(false, 403, "webmcp: web pages may not connect directly");
      return;
    }
    done(true);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    for (const session of [...this.sessions]) session.close(1001, "daemon shutting down");
    const wss = this.wss;
    this.wss = undefined;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

/** One extension connection. Unauthenticated until it presents the token. */
class Session {
  private authed = false;
  private readonly broker: ApprovalBroker;
  private readonly inflight = new Map<string, AbortController>();
  private helloTimer: NodeJS.Timeout;

  constructor(
    private readonly socket: WebSocket,
    private readonly req: IncomingMessage,
    private readonly deps: DaemonServerDeps,
    private readonly onGone: () => void,
  ) {
    this.broker = new ApprovalBroker(deps.config.limits.approvalTimeoutMs, deps.log);

    this.helloTimer = setTimeout(() => {
      this.fail("unauthorized", "no hello within timeout");
      this.close(4401, "unauthorized");
    }, HELLO_TIMEOUT_MS);
    this.helloTimer.unref?.();

    socket.on("message", (data, isBinary) => void this.onMessage(data, isBinary));
    socket.on("close", () => this.teardown("connection closed"));
    socket.on("error", (err) => {
      this.deps.log.warn(`socket error: ${err.message}`);
      this.teardown("socket error");
    });
  }

  send(message: ServerToClientMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  private teardown(reason: string): void {
    clearTimeout(this.helloTimer);
    // Nobody is watching the prompts any more, so they are denials.
    this.broker.denyAll(reason);
    for (const controller of this.inflight.values()) controller.abort(new Error(reason));
    this.inflight.clear();
    this.onGone();
  }

  private fail(code: ErrorCode, message: string, id?: string): void {
    this.send({ kind: "error", code, message, ...(id === undefined ? {} : { id }) });
  }

  private async onMessage(data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.fail("bad_request", "binary frames are not accepted");
      return;
    }
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(String(data)) as ClientMessage;
    } catch {
      this.fail("bad_request", "frame is not valid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof parsed.kind !== "string") {
      this.fail("bad_request", "frame has no kind");
      return;
    }

    if (parsed.kind === "hello") {
      this.onHello(parsed);
      return;
    }
    if (!this.authed) {
      this.fail("unauthorized", "hello first");
      this.close(4401, "unauthorized");
      return;
    }

    switch (parsed.kind) {
      case "list_tools":
        if (typeof parsed.id !== "string") return this.fail("bad_request", "list_tools needs an id");
        this.send({ kind: "tools", id: parsed.id, tools: this.deps.registry.list() });
        return;
      case "call_tool":
        await this.onCallTool(parsed);
        return;
      case "approval_response":
        this.onApprovalResponse(parsed);
        return;
      case "cancel":
        this.inflight.get(parsed.id)?.abort(new Error("cancelled by client"));
        return;
      case "set_workspace":
        await this.onSetWorkspace(parsed);
        return;
      default:
        this.fail("bad_request", `unknown kind ${String((parsed as { kind: string }).kind)}`);
    }
  }

  private onHello(msg: { version?: unknown; token?: unknown; client?: unknown }): void {
    if (this.authed) {
      this.fail("bad_request", "already authenticated");
      return;
    }
    if (msg.version !== WIRE_VERSION) {
      this.fail("version_mismatch", `daemon speaks wire version ${WIRE_VERSION}`);
      this.close(4400, "version mismatch");
      return;
    }
    if (!tokenMatches(this.deps.token, msg.token)) {
      this.deps.log.warn(`rejected connection from ${this.req.socket.remoteAddress}: bad token`);
      this.fail("unauthorized", "pairing token rejected");
      this.close(4401, "unauthorized");
      return;
    }

    clearTimeout(this.helloTimer);
    this.authed = true;
    const label = typeof msg.client === "string" ? msg.client.slice(0, 120) : "extension";
    this.deps.log.info(`paired with ${label}`);
    this.send({
      kind: "ready",
      version: WIRE_VERSION,
      workspace: this.deps.workspaces.root,
      roots: this.deps.workspaces.roots(),
      servers: this.deps.mcp.statuses(),
    });
  }

  private onApprovalResponse(msg: ApprovalResponseMessage): void {
    const decision = msg.decision;
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") {
      this.fail("bad_request", "unknown approval decision");
      return;
    }
    // An unrecognised nonce is the interesting case: a replay, a stale prompt,
    // or something trying to approve a call it was never offered.
    if (!this.broker.resolve(msg.nonce, decision)) {
      this.deps.log.warn("discarded approval for unknown or expired nonce");
    }
  }

  /**
   * Move the workspace root.
   *
   * The authorization is entirely `WorkspaceManager.switchTo`: it accepts only
   * a root the user granted in the config file, or a subdirectory of one. So
   * this handler needs no trust in the caller — the worst a hostile page that
   * somehow reached this message could do is move between directories its user
   * already wrote down, and the move is audited and announced to every session.
   * It cannot name a directory of its own.
   */
  private async onSetWorkspace(msg: { id?: unknown; root?: unknown }): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (typeof msg.root !== "string") {
      this.fail("bad_request", "set_workspace needs a root", id);
      return;
    }
    try {
      const workspace = await this.deps.workspaces.switchTo(msg.root);
      // Answered directly as well as broadcast: the caller needs the reply tied
      // to its id so the popup can report success or failure for *this* click.
      this.send({
        kind: "workspace_changed",
        ...(id === undefined ? {} : { id }),
        workspace: workspace.root,
        roots: this.deps.workspaces.roots(),
      });
    } catch (err) {
      const message = err instanceof WorkspaceRefused ? err.message : String(err);
      this.deps.log.audit(`REFUSED set_workspace ${msg.root}: ${message}`);
      this.fail("workspace_refused", message, id);
    }
  }

  private async onCallTool(msg: CallToolMessage): Promise<void> {
    const { registry, policy, log } = this.deps;

    if (typeof msg.id !== "string" || typeof msg.name !== "string") {
      this.fail("bad_request", "call_tool needs id and name");
      return;
    }
    const id = msg.id;
    const args =
      typeof msg.args === "object" && msg.args !== null && !Array.isArray(msg.args) ? msg.args : {};
    const origin = typeof msg.origin === "string" ? msg.origin.slice(0, 200) : "unknown";

    if (this.inflight.size >= MAX_INFLIGHT) {
      this.fail("bad_request", `too many calls in flight (max ${MAX_INFLIGHT})`, id);
      return;
    }
    if (this.inflight.has(id)) {
      this.fail("bad_request", "duplicate call id", id);
      return;
    }

    const descriptor = registry.describe(msg.name);
    if (!descriptor) {
      log.audit(`refused unknown tool "${msg.name}" from ${origin}`);
      this.fail("unknown_tool", `no tool named "${msg.name}"`, id);
      return;
    }

    // The id is claimed here, before the approval wait — not after it. Awaiting
    // first would let a second call with the same id slip past the duplicate
    // check while the first one is still sitting in front of a human, and raise
    // a second prompt for it. It also makes `cancel` work on a call that has
    // not started yet, and makes MAX_INFLIGHT bound the number of prompts a
    // page can queue up.
    const controller = new AbortController();
    this.inflight.set(id, controller);

    // The jail this call belongs to, pinned here and used for every step below.
    // The root can move while the call sits in front of a human, and a call
    // must run against the workspace it was validated and approved under — the
    // approval prompt names that directory, so anything else is the daemon
    // doing something other than what was agreed to.
    const workspace = this.deps.workspaces.current;

    try {
      // Refuse the obviously-invalid before bothering a human, so an approval
      // prompt always describes something that would actually run if allowed.
      try {
        registry.validate(msg.name, args, workspace);
      } catch (err) {
        const { code, message } = classify(err);
        log.audit(`REJECTED ${descriptor.name} from ${origin}: ${message}`);
        this.fail(code, message, id);
        return;
      }

      // Authorization happens here, before anything runs, using only the
      // daemon's own state. Nothing in `msg` can change the answer.
      if (policy.decide(descriptor, args, workspace.root) === "needs_approval") {
        const outcome = await this.broker.request({
          callId: id,
          descriptor,
          args,
          origin,
          summary: registry.summarize(msg.name, args),
          alwaysLabel: policy.alwaysLabel(descriptor, args, workspace.root),
          signal: controller.signal,
          send: (message) => this.send(message),
        });

        if (outcome === "deny") {
          log.audit(`DENIED ${descriptor.name} from ${origin}`);
          this.fail("denied", "the user declined this call", id);
          return;
        }
        if (outcome === "allow_always") await policy.allowAlways(descriptor, args, workspace.root);
      }

      log.audit(`RUN ${descriptor.name} from ${origin} — ${registry.summarize(msg.name, args)}`);
      const result = await registry.call(msg.name, args, origin, controller.signal, workspace);
      this.send({ kind: "result", id, result });
    } catch (err) {
      const { code, message } = classify(err);
      log.audit(`FAILED ${descriptor.name}: ${message}`);
      this.fail(code, message, id);
    } finally {
      this.inflight.delete(id);
    }
  }
}

function classify(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof JailViolation) return { code: "jail_violation", message: err.message };
  if (err instanceof WorkspaceRefused) return { code: "workspace_refused", message: err.message };
  if (err instanceof ServerUnavailable) return { code: "server_unavailable", message: err.message };
  if (err instanceof ToolError) return { code: err.code as ErrorCode, message: err.message };
  if (err instanceof Error) {
    if (err.name === "AbortError") return { code: "timeout", message: "call was cancelled" };
    return { code: "internal", message: err.message };
  }
  return { code: "internal", message: String(err) };
}

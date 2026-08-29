import type { ToolDescriptor, ToolResult } from "./tools.js";

export const WIRE_VERSION = 1;

/** Default loopback port. Overridable; the extension is told the real one at pairing time. */
export const DEFAULT_PORT = 8767;

/* ------------------------------------------------------------------ */
/* extension -> daemon                                                */
/* ------------------------------------------------------------------ */

/**
 * First frame on every connection. The token is the whole of the daemon's
 * client authentication — Origin headers are forgeable by any page that can
 * open a socket, so they are never trusted.
 */
export interface HelloMessage {
  kind: "hello";
  version: number;
  token: string;
  /** Cosmetic: shown in daemon logs so the user can tell tabs apart. */
  client?: string;
}

export interface ListToolsMessage {
  kind: "list_tools";
  id: string;
}

export interface CallToolMessage {
  kind: "call_tool";
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Host page the call was observed on, for the approval prompt and audit log. */
  origin: string;
  /**
   * This page can upload a file, so an oversized result may come back whole
   * and be attached instead of pasted and truncated.
   *
   * Read this as a statement about the *page*, not a request for permission,
   * because it is the one field here a hostile page can influence and it must
   * be harmless if it lies. It cannot reach anything the caller could not
   * already reach: the jail, the approval and the tool are all decided without
   * it, and a page that already has `fs_read` can page through a whole file
   * with `offset` regardless. All it changes is how many of those bytes come
   * back in one message, and that stays bounded by `limits.maxAttachBytes`
   * from the daemon's own config file.
   */
  canAttach?: boolean;
}

/**
 * Answer to an `approval_request`. Authority stays with the daemon: it only
 * honours a decision whose `nonce` it issued, once, before the deadline.
 */
export interface ApprovalResponseMessage {
  kind: "approval_response";
  nonce: string;
  decision: "allow_once" | "allow_always" | "deny";
}

export interface CancelMessage {
  kind: "cancel";
  id: string;
}

/**
 * Move the workspace root to another directory *the user has already granted*.
 *
 * This is the one message that touches the security model, so read the limit
 * carefully: it can only ever **select** among the roots the daemon already
 * declared in `ready.roots`, or narrow into a subdirectory of one. It cannot
 * name a new directory. The grantable set lives in the daemon's config file,
 * which no page and no extension code can write, so nothing arriving over this
 * socket can widen the grant — only move it within a set a human wrote down.
 *
 * The extension additionally refuses to send it on behalf of a content script,
 * but that gate is not load-bearing: the daemon re-checks independently.
 */
export interface SetWorkspaceMessage {
  kind: "set_workspace";
  id: string;
  root: string;
}

export type ClientMessage =
  | HelloMessage
  | ListToolsMessage
  | CallToolMessage
  | ApprovalResponseMessage
  | CancelMessage
  | SetWorkspaceMessage;

/* ------------------------------------------------------------------ */
/* daemon -> extension                                                */
/* ------------------------------------------------------------------ */

export interface ReadyMessage {
  kind: "ready";
  version: number;
  workspace: string;
  /**
   * Roots the daemon will accept in `set_workspace`, the active one included.
   * Declared in the daemon's config file — this is a report of a decision the
   * user already made on disk, never a menu the extension can add to.
   */
  roots: string[];
  /** Servers the daemon tried to reach, with live status. */
  servers: ServerStatus[];
}

/**
 * The workspace root moved. Sent to every session, not just the one that asked,
 * because a stale root in another tab's popup is a lie about what the tools can
 * reach.
 */
export interface WorkspaceChangedMessage {
  kind: "workspace_changed";
  /** Present when this answers a `set_workspace`; absent when the daemon moved itself. */
  id?: string;
  workspace: string;
  roots: string[];
}

export interface ServerStatus {
  id: string;
  state: "connected" | "failed" | "connecting" | "disabled";
  toolCount: number;
  error?: string;
}

export interface ToolsMessage {
  kind: "tools";
  id: string;
  tools: ToolDescriptor[];
}

/** Pushed unprompted when a downstream server connects or drops. */
export interface ToolsChangedMessage {
  kind: "tools_changed";
  servers: ServerStatus[];
}

export interface ResultMessage {
  kind: "result";
  id: string;
  result: ToolResult;
}

/**
 * The daemon is asking a human. The extension renders this and nothing else —
 * it does not get to decide, and it cannot mint its own nonce.
 */
export interface ApprovalRequestMessage {
  kind: "approval_request";
  nonce: string;
  callId: string;
  tool: string;
  risk: string;
  origin: string;
  /** Human-readable rendering of what will happen, built by the daemon. */
  summary: string;
  /** Pretty-printed arguments, already redacted/truncated by the daemon. */
  detail: string;
  /** Epoch ms after which the daemon will auto-deny. */
  expiresAt: number;
  /** True when "always allow" would be meaningful for this call shape. */
  allowAlwaysLabel?: string;
}

export interface ErrorMessage {
  kind: "error";
  /** Present when the failure belongs to a specific request. */
  id?: string;
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | "unauthorized"
  | "version_mismatch"
  | "bad_request"
  | "unknown_tool"
  | "denied"
  | "jail_violation"
  | "workspace_refused"
  | "timeout"
  | "server_unavailable"
  | "internal";

export type ServerToClientMessage =
  | ReadyMessage
  | ToolsMessage
  | ToolsChangedMessage
  | WorkspaceChangedMessage
  | ResultMessage
  | ApprovalRequestMessage
  | ErrorMessage;

/* ------------------------------------------------------------------ */
/* content script <-> service worker                                  */
/* ------------------------------------------------------------------ */

/**
 * Everything a hostile page could reach. Note what is absent: no token, no
 * workspace, no approval decision. The content script can ask for tools and
 * ask to run one; it can never widen what "running one" is allowed to mean.
 */
export type PageRequest =
  | { kind: "page_list_tools" }
  | {
      kind: "page_call_tool";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      /** True when this host has a file input we could upload a big result to. */
      canAttach?: boolean;
    }
  | { kind: "page_status" }
  /**
   * The content script telling the worker something went wrong in the DOM, so
   * the popup can show it instead of the user staring at a page where nothing
   * happened. Carries only strings, and they are rendered as text.
   */
  | { kind: "page_report"; level: "warn" | "error"; message: string };

export type PageResponse =
  | { kind: "page_tools"; tools: ToolDescriptor[] }
  | { kind: "page_result"; callId: string; result: ToolResult }
  | { kind: "page_status_reply"; connected: boolean; workspace: string | null }
  | { kind: "page_error"; callId?: string; message: string };

/**
 * Service worker to content script. Injecting the preamble is a push because it
 * is a user action taken in the popup, not something the page may ask for.
 */
export type WorkerToPageMessage =
  | { kind: "inject_preamble" }
  | { kind: "diagnose" }
  | { kind: "connection_changed"; connected: boolean };

/**
 * What the content script can see of the page. Exists because "injection
 * failed" is otherwise invisible: the selectors live in one file per host and
 * every one of these sites reships its DOM, so the first question is always
 * *which* selector stopped matching.
 */
export interface PageDiagnostics {
  host: string;
  /** Adapter id, or null when no adapter claims this host. */
  adapter: string | null;
  conversationRoot: boolean;
  assistantTurns: number;
  /** Human-readable description of the element found, or null if none was. */
  composer: string | null;
  submitButton: string | null;
  /** The upload input a too-large result would go to, or null if there is none. */
  fileInput: string | null;
  streaming: boolean;
  codeBlocks: number;
  /**
   * Calls the scanner deliberately did not run — they were already on screen
   * when it attached, or they had gone stale. The number that answers "why did
   * nothing happen when I reopened this tab", which is otherwise invisible.
   */
  skippedCalls: number;
  /** What the fence scanner currently sees, which is the whole game when a
   *  call is emitted but never runs. */
  blocks: {
    tag: string | null;
    closed: boolean;
    looksLikeCall: boolean;
    preview: string;
  }[];
  lastError: string | null;
}

/* ------------------------------------------------------------------ */
/* popup <-> service worker                                           */
/* ------------------------------------------------------------------ */

/**
 * Privileged channel. These carry the token and approval decisions, so the
 * service worker must accept them only from an extension page — never from a
 * content script, which is reachable by the page.
 */
export type PopupRequest =
  | { kind: "ui_get_state" }
  | { kind: "ui_pair"; token: string; port: number }
  | { kind: "ui_unpair" }
  | { kind: "ui_reconnect" }
  | { kind: "ui_approve"; nonce: string; decision: "allow_once" | "allow_always" | "deny" }
  | { kind: "ui_inject_preamble"; tabId: number }
  | { kind: "ui_diagnose"; tabId: number }
  | { kind: "ui_set_workspace"; root: string };

export interface UiState {
  connected: boolean;
  paired: boolean;
  port: number;
  workspace: string | null;
  /** Roots the daemon offers to switch between. One entry means no choice to make. */
  workspaceRoots: string[];
  toolCount: number;
  servers: ServerStatus[];
  pendingApprovals: ApprovalRequestMessage[];
  lastError: string | null;
  /** Most recent DOM-side complaint from a content script, if any. */
  pageError: string | null;
}

export type PopupResponse =
  | { kind: "ui_state"; state: UiState }
  | { kind: "ui_ok" }
  | { kind: "ui_diagnostics"; report: PageDiagnostics }
  | { kind: "ui_error"; message: string };

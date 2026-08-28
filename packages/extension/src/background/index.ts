import type {
  ApprovalRequestMessage,
  PageDiagnostics,
  PageRequest,
  PageResponse,
  PopupRequest,
  PopupResponse,
  UiState,
  WorkerToPageMessage,
} from "@webmcp/protocol";
import { DaemonConnection } from "./connection.js";
import { clearPairing, loadPairing, savePairing } from "./store.js";

/**
 * The service worker: broker and nothing more.
 *
 * It holds the socket and the pairing token, so it is the only place in the
 * extension with any authority at all — and the authority it has is "may talk
 * to the daemon", not "may decide what runs". Two rules keep that honest:
 *
 *  1. Messages from a content script are treated as coming from the page. Only
 *     the three `page_*` requests are accepted from there, and none of them can
 *     change pairing, approve a call, or name a workspace.
 *  2. The privileged `ui_*` requests are accepted only from an extension page.
 *     A content script asking to approve something is a bug or an attack; it is
 *     refused either way.
 */

const KEEPALIVE_ALARM = "webmcp-keepalive";

const pendingApprovals = new Map<string, ApprovalRequestMessage>();
/** Last DOM-side complaint, so the popup can explain a failed injection. */
let pageError: string | null = null;

const connection = new DaemonConnection({
  onStateChange: () => {
    void updateBadge();
  },
  onApprovalRequest: (request) => {
    pendingApprovals.set(request.nonce, request);
    // Expire the card at the same moment the daemon stops accepting it, so the
    // popup never offers a button that would be discarded.
    setTimeout(
      () => {
        pendingApprovals.delete(request.nonce);
        void updateBadge();
      },
      Math.max(1_000, request.expiresAt - Date.now()),
    );
    void updateBadge();
    // Best effort: Chrome only allows this in response to some user gestures.
    chrome.action.openPopup?.().catch(() => {});
  },
});

void bootstrap();

async function bootstrap(): Promise<void> {
  const pairing = await loadPairing();
  if (pairing) connection.connect(pairing);
  await updateBadge();

  // WebSocket traffic keeps an MV3 worker alive, but an idle connection plus a
  // terminated worker is a real state — the alarm is what gets us back.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) connection.ensureConnected();
});

chrome.runtime.onStartup.addListener(() => void bootstrap());
chrome.runtime.onInstalled.addListener(() => void bootstrap());

chrome.runtime.onMessage.addListener(
  (message: PageRequest | PopupRequest, sender, sendResponse): boolean => {
    // A content script has a tab; an extension page does not. That distinction
    // is the whole privilege boundary inside the extension.
    const fromPage = sender.tab !== undefined;

    if (fromPage) {
      if (!isPageRequest(message)) {
        sendResponse({ kind: "page_error", message: "not permitted from a page" } satisfies PageResponse);
        return false;
      }
      void handlePageRequest(message, sender).then(sendResponse);
      return true;
    }

    if (sender.id !== chrome.runtime.id || !isPopupRequest(message)) {
      sendResponse({ kind: "ui_error", message: "not permitted" } satisfies PopupResponse);
      return false;
    }
    void handlePopupRequest(message).then(sendResponse);
    return true;
  },
);

function isPageRequest(message: unknown): message is PageRequest {
  const kind = (message as { kind?: unknown })?.kind;
  return (
    kind === "page_list_tools" ||
    kind === "page_call_tool" ||
    kind === "page_status" ||
    kind === "page_report"
  );
}

function isPopupRequest(message: unknown): message is PopupRequest {
  const kind = (message as { kind?: unknown })?.kind;
  return (
    kind === "ui_get_state" ||
    kind === "ui_pair" ||
    kind === "ui_unpair" ||
    kind === "ui_reconnect" ||
    kind === "ui_approve" ||
    kind === "ui_inject_preamble" ||
    kind === "ui_diagnose"
  );
}

async function handlePageRequest(
  message: PageRequest,
  sender: chrome.runtime.MessageSender,
): Promise<PageResponse> {
  // Handled before the connection check: a report is the content script telling
  // us why nothing happened, which is most useful precisely when things are
  // broken. The text is rendered as text, never as markup.
  if (message.kind === "page_report") {
    pageError = String(message.message).slice(0, 300);
    return { kind: "page_status_reply", connected: connection.connected, workspace: connection.workspace };
  }

  if (!connection.connected) {
    return { kind: "page_error", message: "WebMCP is not connected to a daemon" };
  }

  switch (message.kind) {
    case "page_status":
      return {
        kind: "page_status_reply",
        connected: connection.connected,
        workspace: connection.workspace,
      };

    case "page_list_tools":
      try {
        return { kind: "page_tools", tools: await connection.listTools() };
      } catch (err) {
        return { kind: "page_error", message: (err as Error).message };
      }

    case "page_call_tool": {
      // The origin is taken from the sender, not from the message: the page
      // must not be able to claim it is somewhere else in the audit log.
      const origin = sender.origin ?? sender.url ?? "unknown";
      const args =
        typeof message.args === "object" && message.args !== null && !Array.isArray(message.args)
          ? message.args
          : {};
      try {
        const result = await connection.callTool(String(message.name), args, origin);
        return { kind: "page_result", callId: message.callId, result };
      } catch (err) {
        return { kind: "page_error", callId: message.callId, message: (err as Error).message };
      }
    }
  }
}

async function handlePopupRequest(message: PopupRequest): Promise<PopupResponse> {
  switch (message.kind) {
    case "ui_get_state":
      return { kind: "ui_state", state: snapshot() };

    case "ui_pair": {
      const token = String(message.token).trim();
      const port = Number(message.port);
      if (token.length < 32) return { kind: "ui_error", message: "that does not look like a token" };
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { kind: "ui_error", message: "port must be between 1 and 65535" };
      }
      await savePairing({ token, port });
      connection.connect({ token, port });
      return { kind: "ui_ok" };
    }

    case "ui_unpair":
      await clearPairing();
      connection.disconnect();
      pendingApprovals.clear();
      await updateBadge();
      return { kind: "ui_ok" };

    case "ui_reconnect":
      connection.ensureConnected();
      return { kind: "ui_ok" };

    case "ui_approve": {
      const request = pendingApprovals.get(message.nonce);
      if (!request) return { kind: "ui_error", message: "that prompt has expired" };
      pendingApprovals.delete(message.nonce);
      await updateBadge();
      try {
        connection.respondToApproval(message.nonce, message.decision);
        return { kind: "ui_ok" };
      } catch (err) {
        return { kind: "ui_error", message: (err as Error).message };
      }
    }

    case "ui_inject_preamble": {
      pageError = null;
      const reply = await messageTab(message.tabId, { kind: "inject_preamble" });
      if (!reply.ok) return { kind: "ui_error", message: reply.error };
      const body = reply.value as { ok?: boolean; error?: string } | undefined;
      if (body?.ok === false) {
        return { kind: "ui_error", message: body.error ?? "the page refused to inject" };
      }
      return { kind: "ui_ok" };
    }

    case "ui_diagnose": {
      const reply = await messageTab(message.tabId, { kind: "diagnose" });
      if (!reply.ok) return { kind: "ui_error", message: reply.error };
      const report = reply.value as PageDiagnostics | undefined;
      if (!report?.host) {
        return { kind: "ui_error", message: "the page answered but sent no diagnostics" };
      }
      return { kind: "ui_diagnostics", report };
    }
  }
}

/**
 * Message a tab's content script, injecting it first if it is not there.
 *
 * A declarative `content_scripts` entry only runs on page load, so any tab that
 * was already open when the extension was installed or reloaded has no content
 * script in it — which is the overwhelmingly common cause of "no content
 * script in that tab". Telling the user to reload the page works, but having
 * the worker just inject it works better, and it removes a step that is easy to
 * do in the wrong order.
 */
async function messageTab(
  tabId: number,
  message: WorkerToPageMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await chrome.tabs.sendMessage(tabId, message) };
  } catch {
    // Fall through to injection.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    const detail = (err as Error).message;
    return {
      ok: false,
      error: /cannot access|chrome:\/\/|extension/i.test(detail)
        ? "WebMCP cannot run on this page — open chatgpt.com, claude.ai or perplexity.ai"
        : `could not inject into the page: ${detail}`,
    };
  }

  try {
    return { ok: true, value: await chrome.tabs.sendMessage(tabId, message) };
  } catch (err) {
    return {
      ok: false,
      error: `the page did not answer after injecting: ${(err as Error).message}`,
    };
  }
}

function snapshot(): UiState {
  return {
    connected: connection.connected,
    paired: connection.state !== "idle",
    port: 0,
    workspace: connection.workspace,
    toolCount: connection.tools.length,
    servers: connection.servers,
    pendingApprovals: [...pendingApprovals.values()],
    lastError: connection.lastError,
    pageError,
  };
}

async function updateBadge(): Promise<void> {
  const pending = pendingApprovals.size;
  const text = pending > 0 ? String(pending) : connection.connected ? "" : "!";
  const color = pending > 0 ? "#d97706" : "#b91c1c";
  await chrome.action.setBadgeText({ text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  await chrome.action
    .setTitle({
      title: pending
        ? `WebMCP — ${pending} call${pending === 1 ? "" : "s"} waiting for approval`
        : connection.connected
          ? `WebMCP — connected (${connection.tools.length} tools)`
          : `WebMCP — not connected${connection.lastError ? `: ${connection.lastError}` : ""}`,
    })
    .catch(() => {});
}

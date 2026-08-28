import {
  DEFAULT_PORT,
  type ApprovalRequestMessage,
  type PageDiagnostics,
  type PopupRequest,
  type PopupResponse,
  type UiState,
} from "@webmcp/protocol";

/**
 * The approval UI. This is where a human actually decides, so the one thing it
 * must never do is treat any of the text it renders as markup — a tool
 * argument came from a page that may have been prompt-injected, and a
 * convincing fake "already approved" banner is exactly what such a page would
 * try to inject. Everything below sets `textContent`.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup markup is missing #${id}`);
  return found as T;
};

const dot = el("dot");
const errorLine = el<HTMLParagraphElement>("error");
const sections = {
  approvals: el("approvals"),
  status: el("status"),
  pair: el("pair"),
};

async function ask(request: PopupRequest): Promise<PopupResponse> {
  try {
    return (await chrome.runtime.sendMessage(request)) as PopupResponse;
  } catch (err) {
    return { kind: "ui_error", message: (err as Error).message };
  }
}

function showError(message: string | null): void {
  errorLine.textContent = message ?? "";
  errorLine.hidden = message === null;
}

async function refresh(): Promise<void> {
  const reply = await ask({ kind: "ui_get_state" });
  if (reply.kind !== "ui_state") {
    showError(reply.kind === "ui_error" ? reply.message : "no reply from WebMCP");
    return;
  }
  render(reply.state);
}

function render(state: UiState): void {
  const pending = state.pendingApprovals.length;

  dot.className = `dot ${pending ? "pending" : state.connected ? "ok" : ""}`.trim();
  el("reconnect").hidden = state.connected || !state.paired;

  sections.approvals.hidden = pending === 0;
  if (pending) renderApprovals(state.pendingApprovals);

  sections.status.hidden = !state.paired;
  sections.pair.hidden = state.paired;

  if (state.paired) {
    el("workspace").textContent = state.workspace ?? (state.connected ? "—" : "not connected");
    el("tools").textContent = String(state.toolCount);
    el("servers").textContent = state.servers.length
      ? state.servers
          .map((s) => `${s.id} (${s.state}${s.state === "connected" ? `, ${s.toolCount}` : ""})`)
          .join(", ")
      : "none";
  } else {
    el<HTMLInputElement>("port").value ||= String(DEFAULT_PORT);
  }

  // A DOM-side failure is the more actionable message when there is one: the
  // socket being fine is not much comfort if the page never got the preamble.
  showError(state.pageError ?? (state.connected || !state.paired ? null : state.lastError));
}

function renderApprovals(requests: ApprovalRequestMessage[]): void {
  const list = el("approval-list");
  list.textContent = "";

  for (const request of requests) {
    const card = document.createElement("div");
    card.className = "approval";

    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = request.summary;

    const meta = document.createElement("p");
    meta.className = "meta";
    const seconds = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
    meta.textContent = `${request.tool} · ${request.risk} · from ${request.origin} · ${seconds}s left`;

    const detail = document.createElement("pre");
    detail.textContent = request.detail;

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      button("Allow once", "primary", () => decide(request.nonce, "allow_once")),
      button("Deny", "danger", () => decide(request.nonce, "deny")),
    );

    card.append(summary, meta, detail, row);
    if (request.allowAlwaysLabel) {
      card.append(
        button(request.allowAlwaysLabel, "ghost", () => decide(request.nonce, "allow_always")),
      );
    }
    list.append(card);
  }
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function decide(
  nonce: string,
  decision: "allow_once" | "allow_always" | "deny",
): Promise<void> {
  const reply = await ask({ kind: "ui_approve", nonce, decision });
  if (reply.kind === "ui_error") showError(reply.message);
  await refresh();
}

el("do-pair").addEventListener("click", async () => {
  const token = el<HTMLInputElement>("token").value.trim();
  const port = Number(el<HTMLInputElement>("port").value);
  const reply = await ask({ kind: "ui_pair", token, port });
  if (reply.kind === "ui_error") {
    showError(reply.message);
    return;
  }
  el<HTMLInputElement>("token").value = "";
  showError(null);
  // Give the socket a moment to finish the handshake before redrawing.
  setTimeout(() => void refresh(), 400);
});

el("unpair").addEventListener("click", async () => {
  await ask({ kind: "ui_unpair" });
  await refresh();
});

el("reconnect").addEventListener("click", async () => {
  await ask({ kind: "ui_reconnect" });
  setTimeout(() => void refresh(), 400);
});

el("diagnose").addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (tabId === null) return;
  const reply = await ask({ kind: "ui_diagnose", tabId });
  if (reply.kind !== "ui_diagnostics") {
    showError(reply.kind === "ui_error" ? reply.message : "no diagnostics");
    return;
  }
  showReport(reply.report);
});

el("inject").addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (tabId === null) return;
  const reply = await ask({ kind: "ui_inject_preamble", tabId });
  showError(reply.kind === "ui_error" ? reply.message : null);
});

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    showError("no active tab");
    return null;
  }
  return tab.id;
}

/**
 * The report is built from page-controlled strings (element labels, placeholder
 * text), so it goes in as `textContent`. Never markup.
 */
function showReport(report: PageDiagnostics): void {
  const rows = [
    `host        ${report.host}`,
    `adapter     ${report.adapter ?? "none — this host is not supported"}`,
    `turns root  ${report.conversationRoot ? "found" : "MISSING"}`,
    `turns       ${report.assistantTurns}`,
    `composer    ${report.composer ?? "MISSING"}`,
    `send button ${report.submitButton ?? "MISSING"}`,
    `streaming   ${report.streaming}`,
    `code blocks ${report.codeBlocks}`,
  ];
  if (report.blocks.length) {
    rows.push(``, `code blocks the scanner sees:`);
    for (const block of report.blocks) {
      rows.push(
        `  tag=${block.tag ?? "none"} closed=${block.closed} isCall=${block.looksLikeCall}`,
        `    ${block.preview}`,
      );
    }
  }
  if (report.lastError) rows.push(``, `last error  ${report.lastError}`);

  const pre = el<HTMLPreElement>("report");
  pre.textContent = rows.join("\n");
  pre.hidden = false;
}

void refresh();
// The countdown on a pending approval has to keep moving while the popup is open.
setInterval(() => void refresh(), 1_000);

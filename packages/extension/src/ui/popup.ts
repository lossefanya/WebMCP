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

/**
 * The message line, which has two kinds of content with different lifetimes.
 *
 * *Ambient* text describes a standing condition — the socket is down, the
 * content script complained — and is recomputed from state on every redraw, so
 * it comes and goes with the condition itself.
 *
 * A *flash* is the answer to something the user just did: a refusal, or a
 * "that worked, now do this". It has to outlive the redraw, and that is the
 * whole reason this is not one variable. `render()` runs once a second to keep
 * the approval countdown moving, and it used to end by rewriting this line
 * unconditionally — so every message the user actually needed to read was wiped
 * within a second of appearing.
 *
 * A flash therefore wins over ambient text, and it stays until the user clicks
 * it away or another flash replaces it. No timeout: a message that removes
 * itself is a message that can be missed entirely, and the popup is often not
 * the window being looked at when it appears.
 *
 * Ambient text is deliberately *not* dismissible — it describes a live
 * condition, so clearing it would only last until the next redraw a second
 * later, which reads as a broken control. Only a flash gets the pointer cursor.
 */
interface Flash {
  text: string;
  tone: "error" | "info";
}

let flash: Flash | null = null;
let ambient: string | null = null;

function paintMessage(): void {
  const text = flash?.text ?? ambient;
  errorLine.textContent = text ?? "";
  errorLine.hidden = text === null;
  errorLine.className = flash?.tone === "info" ? "notice" : "error";
  if (flash !== null) errorLine.classList.add("dismissible");
  errorLine.title = flash === null ? "" : "Click to dismiss";
}

/** Something the user just did failed. Stays until dismissed. */
function showError(message: string | null): void {
  flash = message === null ? null : { text: message, tone: "error" };
  paintMessage();
}

/** Something the user just did worked, and there is a next step. */
function showNotice(message: string): void {
  flash = { text: message, tone: "info" };
  paintMessage();
}

// Dismissing matters because the line is also where the *next* message will
// appear — a stale one sitting there makes a new one easy to miss.
errorLine.addEventListener("click", () => {
  if (flash === null) return;
  flash = null;
  paintMessage();
});

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
    renderSwitcher(state);
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
  ambient = state.pageError ?? (state.connected || !state.paired ? null : state.lastError);
  paintMessage();
}

/**
 * The workspace picker.
 *
 * The options come from the daemon, which built them from its config file — the
 * popup neither knows nor decides which directories are allowed, it just draws
 * the list it was handed.
 *
 * Shown even when there is only one root. Hiding it until a second appeared was
 * worse: the feature was invisible to anyone who had not already used it, and
 * the hint naming `--set-workspace` — the only way to add a second — was hidden
 * along with it, so the control only showed up once you no longer needed telling.
 *
 * Rebuilt only when the list actually changes: this runs once a second for the
 * approval countdown, and resetting a <select> under someone mid-choice would
 * make it unusable.
 */
let renderedRoots = "";

function renderSwitcher(state: UiState): void {
  const roots = state.workspaceRoots;
  // Nothing at all to draw only when the daemon has told us nothing yet.
  el("switcher").hidden = roots.length === 0;
  if (roots.length === 0) {
    renderedRoots = "";
    return;
  }

  const signature = roots.join("\u0000");
  const pick = el<HTMLSelectElement>("workspace-pick");
  if (signature !== renderedRoots) {
    renderedRoots = signature;
    pick.textContent = "";
    for (const root of roots) {
      const option = document.createElement("option");
      option.value = root;
      // A path is daemon-supplied, but it is still text, never markup.
      option.textContent = root;
      pick.append(option);
    }
  }
  if (state.workspace && pick.value !== state.workspace) pick.value = state.workspace;

  // With the socket down the roots on screen are the last ones the daemon
  // reported, and a switch would only produce "not connected". Offering a
  // control that cannot work is worse than plainly greying it out.
  // With one root there is nowhere to go, so the control is visible but inert —
  // it is there to say the feature exists and how to feed it.
  const nowhereToGo = roots.length < 2;
  pick.disabled = !state.connected || nowhereToGo;
  el<HTMLButtonElement>("do-switch").disabled = !state.connected || nowhereToGo;
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

el("do-switch").addEventListener("click", async () => {
  const root = el<HTMLSelectElement>("workspace-pick").value;
  const reply = await ask({ kind: "ui_set_workspace", root });
  if (reply.kind === "ui_error") {
    showError(reply.message);
    return;
  }
  await refresh();
  // The conversation still holds a preamble naming the old root, and every
  // result already pasted into it came from there. Saying so is the difference
  // between a switch that works and a model confidently reading the wrong tree.
  showNotice("Workspace changed — inject the tool instructions again so the chat knows.");
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

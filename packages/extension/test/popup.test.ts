import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopupRequest, PopupResponse, UiState } from "@webmcp/protocol";

/**
 * The workspace picker in the popup.
 *
 * Loaded against the *real* `popup.html`, not a hand-written fragment: the
 * markup and the script are two files that have to agree on every id, and a
 * fixture copy would let them drift apart silently — `el()` throws on a missing
 * id, so a rename in one file must fail here.
 *
 * The popup is also where a human actually decides, so the rendering assertions
 * below are about text, never markup.
 */
const POPUP_HTML = fs.readFileSync(
  path.resolve(__dirname, "../public/popup.html"),
  "utf8",
);

const baseState = (over: Partial<UiState> = {}): UiState => ({
  connected: true,
  paired: true,
  port: 8767,
  workspace: "/home/me/project-a",
  workspaceRoots: ["/home/me/project-a", "/home/me/project-b"],
  toolCount: 5,
  servers: [],
  pendingApprovals: [],
  lastError: null,
  pageError: null,
  ...over,
});

/** Every request the popup made, in order. */
let sent: PopupRequest[];
let reply: (request: PopupRequest) => PopupResponse;

async function mountPopup(state: UiState): Promise<void> {
  document.documentElement.innerHTML = POPUP_HTML.replace(/<!doctype html>/i, "");
  sent = [];
  reply = (request) =>
    request.kind === "ui_get_state" ? { kind: "ui_state", state } : { kind: "ui_ok" };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (request: PopupRequest) => {
        sent.push(request);
        return Promise.resolve(reply(request));
      },
      getManifest: () => ({ version: "0.0.1" }),
    },
    tabs: { query: () => Promise.resolve([{ id: 1 }]) },
  };

  // The module runs `refresh()` and installs a 1s interval on import, so each
  // test needs its own instance rather than a cached one.
  vi.resetModules();
  await import("../src/ui/popup.js");
  await flush();
}

/** The popup renders from an awaited sendMessage, so let the microtasks drain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Raise a flash through a path that needs no daemon: "no active tab". */
async function showAFlash(): Promise<void> {
  (globalThis as unknown as { chrome: { tabs: { query: () => Promise<unknown[]> } } }).chrome.tabs.query =
    () => Promise.resolve([{}]);
  el<HTMLButtonElement>("diagnose").click();
  await flush();
}

describe("popup workspace picker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("lists every root the daemon offers, and marks the active one", async () => {
    await mountPopup(baseState());

    expect(el("switcher").hidden).toBe(false);
    const pick = el<HTMLSelectElement>("workspace-pick");
    expect([...pick.options].map((o) => o.value)).toEqual([
      "/home/me/project-a",
      "/home/me/project-b",
    ]);
    expect(pick.value).toBe("/home/me/project-a");
  });

  it("shows with a single root, so the feature is discoverable", async () => {
    // Hiding it until a second root appeared meant the control — and the hint
    // naming the command that adds one — only showed up once you no longer
    // needed telling.
    await mountPopup(baseState({ workspaceRoots: ["/home/me/project-a"] }));
    expect(el("switcher").hidden).toBe(false);
    expect(el("switcher").textContent).toMatch(/--set-workspace/);
  });

  it("is inert with a single root — visible, but there is nowhere to go", async () => {
    await mountPopup(baseState({ workspaceRoots: ["/home/me/project-a"] }));
    expect(el<HTMLSelectElement>("workspace-pick").disabled).toBe(true);
    expect(el<HTMLButtonElement>("do-switch").disabled).toBe(true);
  });

  it("comes alive as soon as a second root is granted", async () => {
    // The daemon pushes the new list over the open socket, so this must not
    // need a reconnect or an extension reload.
    await mountPopup(baseState({ workspaceRoots: ["/home/me/project-a"] }));
    expect(el<HTMLButtonElement>("do-switch").disabled).toBe(true);

    reply = () => ({ kind: "ui_state", state: baseState() });
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();

    expect(el<HTMLButtonElement>("do-switch").disabled).toBe(false);
    expect([...el<HTMLSelectElement>("workspace-pick").options]).toHaveLength(2);
  });

  it("stays hidden before pairing", async () => {
    await mountPopup(baseState({ paired: false, connected: false }));
    expect(el("status").hidden).toBe(true);
  });

  it("asks the worker to switch, naming the chosen root", async () => {
    await mountPopup(baseState());
    const pick = el<HTMLSelectElement>("workspace-pick");
    pick.value = "/home/me/project-b";

    el<HTMLButtonElement>("do-switch").click();
    await flush();

    expect(sent).toContainEqual({ kind: "ui_set_workspace", root: "/home/me/project-b" });
  });

  it("tells the user to re-inject after a switch", async () => {
    // The conversation still holds a preamble naming the old root; silence here
    // means a model confidently reading the wrong tree.
    await mountPopup(baseState());
    el<HTMLButtonElement>("do-switch").click();
    await flush();
    await flush();

    const error = el<HTMLParagraphElement>("error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toMatch(/inject the tool instructions again/i);
  });

  it("keeps a notice on screen across the one-second redraws", async () => {
    // The bug: `render()` runs every second for the approval countdown and used
    // to rewrite the message line unconditionally, so anything the user needed
    // to read was gone within a second of appearing.
    await mountPopup(baseState());
    el<HTMLButtonElement>("do-switch").click();
    await flush();
    await flush();

    const line = el<HTMLParagraphElement>("error");
    expect(line.textContent).toMatch(/inject the tool instructions again/i);

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toMatch(/inject the tool instructions again/i);
  });

  it("stays until the user clicks it, however long that takes", async () => {
    // A message that removes itself is a message that can be missed entirely,
    // and the popup is often not the window being looked at when it appears.
    await mountPopup(baseState());
    el<HTMLButtonElement>("do-switch").click();
    await flush();
    await flush();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();

    const line = el<HTMLParagraphElement>("error");
    expect(line.hidden).toBe(false);
    expect(line.textContent).toMatch(/inject the tool instructions again/i);

    line.click();
    expect(line.hidden).toBe(true);
  });

  it("marks a dismissible message, and leaves ambient text alone", async () => {
    // Ambient text describes a live condition, so clicking it would only clear
    // it until the next redraw a second later — which reads as broken.
    await mountPopup(baseState({ connected: false, lastError: "daemon not reachable" }));
    const line = el<HTMLParagraphElement>("error");
    expect(line.classList.contains("dismissible")).toBe(false);

    line.click();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("daemon not reachable");
  });

  it("replaces one flash with the next rather than queueing them", async () => {
    await mountPopup(baseState());
    el<HTMLButtonElement>("do-switch").click();
    await flush();
    await flush();
    expect(el("error").className).toContain("notice");

    reply = (request) =>
      request.kind === "ui_get_state"
        ? { kind: "ui_state", state: baseState() }
        : { kind: "ui_error", message: "that prompt has expired" };
    el<HTMLButtonElement>("do-switch").click();
    await flush();

    const line = el<HTMLParagraphElement>("error");
    expect(line.textContent).toBe("that prompt has expired");
    expect(line.className).toContain("error");
  });

  it("styles a confirmation as a notice, not as an error", async () => {
    // Styling every message as a failure teaches the user to ignore the line
    // that also carries real errors.
    await mountPopup(baseState());
    el<HTMLButtonElement>("do-switch").click();
    await flush();
    await flush();
    expect(el("error").className).toContain("notice");
  });

  it("lets the user dismiss a message early", async () => {
    // The line is also where the next message lands; a stale one hides it.
    await mountPopup(baseState());
    el<HTMLButtonElement>("do-switch").click();
    await flush();
    await flush();

    el("error").click();
    expect(el<HTMLParagraphElement>("error").hidden).toBe(true);
  });

  it("keeps showing a standing condition after a flash expires", async () => {
    // Ambient text describes a condition rather than an event, so it must come
    // back once the transient message is gone.
    await mountPopup(baseState({ connected: false, lastError: "daemon not reachable" }));
    const line = el<HTMLParagraphElement>("error");
    expect(line.textContent).toBe("daemon not reachable");

    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("daemon not reachable");
  });

  it("shows the standing condition again once a flash is dismissed", async () => {
    await mountPopup(baseState({ connected: false, lastError: "daemon not reachable" }));
    await showAFlash();
    const line = el<HTMLParagraphElement>("error");
    expect(line.textContent).toBe("no active tab");

    line.click();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("daemon not reachable");
  });

  it("surfaces a refusal from the daemon instead of pretending it worked", async () => {
    await mountPopup(baseState());
    reply = (request) =>
      request.kind === "ui_get_state"
        ? { kind: "ui_state", state: baseState() }
        : { kind: "ui_error", message: "/etc is not one of the workspaces granted" };

    el<HTMLButtonElement>("do-switch").click();
    await flush();

    const error = el<HTMLParagraphElement>("error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("not one of the workspaces granted");
    // And it must not claim a move happened.
    expect(error.textContent).not.toMatch(/inject the tool instructions again/i);
  });

  it("greys the picker out while the daemon is unreachable", async () => {
    // The roots on screen are the last ones the daemon reported; a switch now
    // would only produce "not connected".
    await mountPopup(baseState({ connected: false }));
    expect(el("switcher").hidden).toBe(false);
    expect(el<HTMLSelectElement>("workspace-pick").disabled).toBe(true);
    expect(el<HTMLButtonElement>("do-switch").disabled).toBe(true);
  });

  it("re-enables it once the daemon is back", async () => {
    await mountPopup(baseState({ connected: true }));
    expect(el<HTMLButtonElement>("do-switch").disabled).toBe(false);
  });

  it("renders a root as text, never as markup", async () => {
    // Roots come from the daemon, but the popup is the one surface where a
    // convincing injected banner would do real damage. Everything is textContent.
    const nasty = "/home/me/<img src=x onerror=alert(1)>";
    await mountPopup(baseState({ workspaceRoots: ["/home/me/project-a", nasty] }));

    const pick = el<HTMLSelectElement>("workspace-pick");
    expect(pick.querySelector("img")).toBeNull();
    expect([...pick.options].map((o) => o.textContent)).toContain(nasty);
  });

  it("leaves a half-made choice alone across the one-second redraw", async () => {
    // The bug: the value was re-synced to the active root on *every* render, and
    // render runs once a second for the approval countdown. Picking the second
    // root snapped back before you could reach the Switch button, which made
    // changing directory impossible.
    await mountPopup(baseState());
    const pick = el<HTMLSelectElement>("workspace-pick");
    pick.value = "/home/me/project-b";

    await vi.advanceTimersByTimeAsync(2_500);
    await flush();

    expect(pick.value).toBe("/home/me/project-b");
  });

  it("still follows the active root when the daemon moves on its own", async () => {
    // Another tab switching, or --set-workspace from a terminal, must still be
    // reflected — the guard above must not freeze the control instead.
    await mountPopup(baseState());
    expect(el<HTMLSelectElement>("workspace-pick").value).toBe("/home/me/project-a");

    reply = () => ({ kind: "ui_state", state: baseState({ workspace: "/home/me/project-b" }) });
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();

    expect(el<HTMLSelectElement>("workspace-pick").value).toBe("/home/me/project-b");
  });

  it("does not rebuild the dropdown on the one-second redraw", async () => {
    // `refresh()` runs every second for the approval countdown. Resetting a
    // <select> under someone mid-choice would make it unusable.
    await mountPopup(baseState());
    const pick = el<HTMLSelectElement>("workspace-pick");
    const before = pick.options[1];

    await vi.advanceTimersByTimeAsync(2_500);
    await flush();

    expect(pick.options[1]).toBe(before);
  });
});

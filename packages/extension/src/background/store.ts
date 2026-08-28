/**
 * Pairing state. The token lives here and nowhere else in the extension —
 * `chrome.storage` is unreachable from page script, so a hostile page cannot
 * read it, and the content script never asks for it.
 */
export interface Pairing {
  token: string;
  port: number;
}

const KEY = "webmcp.pairing";

export async function loadPairing(): Promise<Pairing | null> {
  const bag = await chrome.storage.local.get(KEY);
  const value = bag[KEY] as Partial<Pairing> | undefined;
  if (!value || typeof value.token !== "string" || typeof value.port !== "number") return null;
  return { token: value.token, port: value.port };
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await chrome.storage.local.set({ [KEY]: pairing });
}

export async function clearPairing(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

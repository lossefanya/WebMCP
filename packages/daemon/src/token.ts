import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The pairing token is the daemon's entire answer to "is this my extension?".
 *
 * A WebSocket `Origin` header cannot do this job: any page in the browser can
 * open `ws://127.0.0.1:PORT` and send whatever Origin it likes to the extent
 * the browser lets it, and a native process can send none at all. So the
 * extension is paired out of band — the user copies this token into the popup
 * once — and every connection must present it.
 */
const TOKEN_BYTES = 32;

export interface TokenStore {
  token: string;
  /** True when this run generated it, i.e. the user still needs to pair. */
  fresh: boolean;
  file: string;
}

export async function loadOrCreateToken(stateDir: string): Promise<TokenStore> {
  const file = path.join(stateDir, "token");
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (existing.length >= 32) return { token: existing, fresh: false, file };
  } catch (cause) {
    const err = cause as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw new Error(`cannot read ${file}: ${err.message}`, { cause });
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return { token, fresh: true, file };
}

/** Length-independent, non-short-circuiting comparison. */
export function tokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; hash-free fix is to pad both to a fixed width.
  const width = Math.max(a.length, b.length, 64);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

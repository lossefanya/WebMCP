import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateToken, tokenMatches } from "../src/token.js";

describe("pairing token", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "webmcp-token-"));
  });
  afterEach(() => fsp.rm(dir, { recursive: true, force: true }));

  it("generates a token on first run and keeps it afterwards", async () => {
    const first = await loadOrCreateToken(path.join(dir, "state"));
    expect(first.fresh).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(43);

    const second = await loadOrCreateToken(path.join(dir, "state"));
    expect(second.fresh).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("writes the token so only the user can read it", async () => {
    const store = await loadOrCreateToken(path.join(dir, "state"));
    expect((await fsp.stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it("replaces a token that is too short to be one", async () => {
    const stateDir = path.join(dir, "state");
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(path.join(stateDir, "token"), "short\n");
    const store = await loadOrCreateToken(stateDir);
    expect(store.fresh).toBe(true);
    expect(store.token).not.toBe("short");
  });

  it("accepts only the exact token", () => {
    const token = "a".repeat(43);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}b`)).toBe(false);
    expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(tokenMatches(token, "")).toBe(false);
  });

  it("rejects a non-string without throwing", () => {
    const token = "a".repeat(43);
    for (const value of [undefined, null, 42, {}, [], true]) {
      expect(tokenMatches(token, value)).toBe(false);
    }
  });
});

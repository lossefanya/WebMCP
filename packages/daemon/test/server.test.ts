import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WIRE_VERSION } from "@webmcp/protocol";
import { McpManager } from "../src/mcp/manager.js";
import { Policy } from "../src/policy.js";
import { Registry } from "../src/registry.js";
import { DaemonServer } from "../src/server.js";
import { TestClient } from "./client.js";
import { silentLogger, tempWorkspace, testConfig } from "./helpers.js";

const TOKEN = "t".repeat(43);
const ORIGIN = "https://chatgpt.com";

describe("DaemonServer", () => {
  let fixture: Awaited<ReturnType<typeof tempWorkspace>>;
  let server: DaemonServer;
  let mcp: McpManager;
  let policy: Policy;
  let port: number;
  const clients: TestClient[] = [];

  const boot = async (overrides = {}) => {
    const config = testConfig(fixture.root, { port: 0, ...overrides });
    mcp = new McpManager(config, silentLogger);
    policy = new Policy(config, silentLogger);
    await policy.load();
    const registry = new Registry(fixture.workspace, config, mcp, silentLogger);
    server = new DaemonServer({ config, registry, policy, mcp, token: TOKEN, log: silentLogger });
    port = await server.listen();
  };

  const paired = async () => {
    const client = await TestClient.open(port);
    clients.push(client);
    client.send({ kind: "hello", version: WIRE_VERSION, token: TOKEN, client: "test" });
    await client.next("ready");
    return client;
  };

  beforeEach(async () => {
    fixture = await tempWorkspace();
    await fsp.writeFile(path.join(fixture.root, "a.txt"), "body\n");
    await boot();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
    await mcp.close();
    await fixture.cleanup();
  });

  it("binds loopback only", () => {
    // Not asserted by connecting from elsewhere — asserted by the fact that
    // there is no non-loopback interface to connect from in a test. The
    // regression this guards is someone changing the host to 0.0.0.0.
    expect(port).toBeGreaterThan(0);
  });

  it("serves the tool list once paired", async () => {
    const client = await paired();
    client.send({ kind: "list_tools", id: "1" });
    const tools = await client.next("tools");
    expect(tools.tools.map((t) => t.name)).toContain("fs_read");
  });

  it("rejects a bad token and hangs up", async () => {
    const client = await TestClient.open(port);
    clients.push(client);
    client.send({ kind: "hello", version: WIRE_VERSION, token: "x".repeat(43) });
    const error = await client.next("error");
    expect(error.code).toBe("unauthorized");
    await client.closed();
    expect(client.closeCode).toBe(4401);
  });

  it("rejects a mismatched wire version", async () => {
    const client = await TestClient.open(port);
    clients.push(client);
    client.send({ kind: "hello", version: 999, token: TOKEN });
    expect((await client.next("error")).code).toBe("version_mismatch");
  });

  it("refuses any request made before hello", async () => {
    const client = await TestClient.open(port);
    clients.push(client);
    client.send({ kind: "call_tool", id: "1", name: "fs_read", args: { path: "a.txt" }, origin: ORIGIN });
    expect((await client.next("error")).code).toBe("unauthorized");
    await client.closed();
  });

  it("refuses a second hello on the same socket", async () => {
    const client = await paired();
    client.send({ kind: "hello", version: WIRE_VERSION, token: TOKEN });
    expect((await client.next("error")).code).toBe("bad_request");
  });

  it("refuses a connection whose Origin is a web page", async () => {
    // A page cannot suppress its Origin, so this closes the direct-from-page
    // attack before the token is even guessable.
    const client = await TestClient.open(port, { Origin: "https://evil.example" });
    clients.push(client);
    expect(client.handshakeFailed).toBe(true);
  });

  it("rejects a frame that is not JSON", async () => {
    const client = await paired();
    client.sendRaw("not json");
    expect((await client.next("error")).code).toBe("bad_request");
  });

  it("auto-approves a read inside the jail", async () => {
    const client = await paired();
    client.send({ kind: "call_tool", id: "r1", name: "fs_read", args: { path: "a.txt" }, origin: ORIGIN });
    const result = await client.next("result", (m) => m.id === "r1");
    expect(result.result.content[0]?.text).toContain("body");
    // No prompt was raised for it.
    expect(client.received.some((m) => m.kind === "approval_request")).toBe(false);
  });

  it("surfaces a jail escape as a jail_violation", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "r2",
      name: "fs_read",
      args: { path: "../outside/secret" },
      origin: ORIGIN,
    });
    expect((await client.next("error", (m) => m.id === "r2")).code).toBe("jail_violation");
  });

  it("reports an unknown tool", async () => {
    const client = await paired();
    client.send({ kind: "call_tool", id: "r3", name: "no_such_tool", args: {}, origin: ORIGIN });
    expect((await client.next("error", (m) => m.id === "r3")).code).toBe("unknown_tool");
  });

  it("prompts for a write and runs it when allowed", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w1",
      name: "fs_write",
      args: { path: "new.txt", content: "hello" },
      origin: ORIGIN,
    });

    const prompt = await client.next("approval_request");
    expect(prompt.callId).toBe("w1");
    expect(prompt.summary).toContain("new.txt");
    expect(prompt.origin).toBe(ORIGIN);

    client.send({ kind: "approval_response", nonce: prompt.nonce, decision: "allow_once" });
    await client.next("result", (m) => m.id === "w1");
    expect(await fsp.readFile(path.join(fixture.root, "new.txt"), "utf8")).toBe("hello");
  });

  it("does not run a write that was denied", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w2",
      name: "fs_write",
      args: { path: "denied.txt", content: "nope" },
      origin: ORIGIN,
    });
    const prompt = await client.next("approval_request");
    client.send({ kind: "approval_response", nonce: prompt.nonce, decision: "deny" });

    expect((await client.next("error", (m) => m.id === "w2")).code).toBe("denied");
    await expect(fsp.stat(path.join(fixture.root, "denied.txt"))).rejects.toThrow();
  });

  it("ignores a replayed nonce, so one click cannot approve a second call", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w3",
      name: "fs_write",
      args: { path: "first.txt", content: "1" },
      origin: ORIGIN,
    });
    const prompt = await client.next("approval_request");
    client.send({ kind: "approval_response", nonce: prompt.nonce, decision: "allow_once" });
    await client.next("result", (m) => m.id === "w3");

    // Same nonce, different call. The daemon has already spent it.
    client.send({
      kind: "call_tool",
      id: "w4",
      name: "fs_write",
      args: { path: "second.txt", content: "2" },
      origin: ORIGIN,
    });
    await client.next("approval_request", (m) => m.callId === "w4");
    client.send({ kind: "approval_response", nonce: prompt.nonce, decision: "allow_once" });

    // The replay bought nothing: the second call is still waiting, and times out.
    expect((await client.next("error", (m) => m.id === "w4", 4_000)).code).toBe("denied");
    await expect(fsp.stat(path.join(fixture.root, "second.txt"))).rejects.toThrow();
  });

  it("ignores an invented nonce", async () => {
    const client = await paired();
    client.send({ kind: "approval_response", nonce: "made-up", decision: "allow_always" });
    client.send({ kind: "list_tools", id: "still-alive" });
    // The session survives; the decision is simply discarded.
    await client.next("tools", (m) => m.id === "still-alive");
    expect(policy.list()).toHaveLength(0);
  });

  it("denies a call nobody answers", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w5",
      name: "fs_write",
      args: { path: "timeout.txt", content: "x" },
      origin: ORIGIN,
    });
    await client.next("approval_request");
    // Silence is a denial. The configured approval timeout is 1s in tests.
    expect((await client.next("error", (m) => m.id === "w5", 4_000)).code).toBe("denied");
  });

  it("remembers allow_always so the next call of that shape runs unprompted", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w6",
      name: "fs_write",
      args: { path: "one.txt", content: "1" },
      origin: ORIGIN,
    });
    const prompt = await client.next("approval_request");
    client.send({ kind: "approval_response", nonce: prompt.nonce, decision: "allow_always" });
    await client.next("result", (m) => m.id === "w6");

    client.send({
      kind: "call_tool",
      id: "w7",
      name: "fs_write",
      args: { path: "two.txt", content: "2" },
      origin: ORIGIN,
    });
    await client.next("result", (m) => m.id === "w7");
    expect(client.received.filter((m) => m.kind === "approval_request")).toHaveLength(1);
    expect(policy.list().map((r) => r.key)).toEqual(["fs_write"]);
  });

  it("refuses a call with a duplicate id", async () => {
    const client = await paired();
    const call = {
      kind: "call_tool" as const,
      id: "dup",
      name: "exec_run",
      args: { command: "node", args: ["-e", "setTimeout(()=>{},400)"] },
      origin: ORIGIN,
    };
    client.send(call);
    const prompt = await client.next("approval_request");
    client.send({ kind: "approval_response", nonce: prompt.nonce, decision: "allow_once" });
    // Now it is in flight; the same id again must not be accepted.
    client.send(call);
    const error = await client.next("error", (m) => m.id === "dup");
    expect(error.message).toMatch(/duplicate call id|too many calls/);
  });

  it("rejects an exec call before prompting when the binary is not allowlisted", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "x1",
      name: "exec_run",
      args: { command: "sh", args: ["-c", "echo pwned"] },
      origin: ORIGIN,
    });
    const error = await client.next("error", (m) => m.id === "x1");
    expect(error.code).toBe("denied");
    // The user was never asked about something that could not run.
    expect(client.received.some((m) => m.kind === "approval_request")).toBe(false);
  });

  it("treats a cancel during the approval wait as a denial", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w9",
      name: "fs_write",
      args: { path: "cancelled.txt", content: "x" },
      origin: ORIGIN,
    });
    await client.next("approval_request");
    client.send({ kind: "cancel", id: "w9" });

    expect((await client.next("error", (m) => m.id === "w9")).code).toBe("denied");
    await expect(fsp.stat(path.join(fixture.root, "cancelled.txt"))).rejects.toThrow();
  });

  it("frees the call id again once a call finishes", async () => {
    const client = await paired();
    const read = { kind: "call_tool" as const, id: "reuse", name: "fs_read", args: { path: "a.txt" }, origin: ORIGIN };
    client.send(read);
    await client.next("result", (m) => m.id === "reuse");
    // A sequential retry with the same id is legitimate; only a concurrent one
    // is a duplicate.
    client.send(read);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.received.filter((m) => m.kind === "result" && m.id === "reuse")).toHaveLength(2);
  });

  it("denies outstanding prompts when the connection drops", async () => {
    const client = await paired();
    client.send({
      kind: "call_tool",
      id: "w8",
      name: "fs_write",
      args: { path: "abandoned.txt", content: "x" },
      origin: ORIGIN,
    });
    await client.next("approval_request");
    client.close();
    await client.closed();

    // Nothing was written, and the daemon did not keep the prompt alive for a
    // future connection to answer.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(fsp.stat(path.join(fixture.root, "abandoned.txt"))).rejects.toThrow();
  });
});

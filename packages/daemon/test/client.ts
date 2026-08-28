import { WebSocket } from "ws";
import type { ClientMessage, ServerToClientMessage } from "@webmcp/protocol";

/**
 * Minimal wire client for the server tests. Deliberately not the extension's
 * connection class — the point is to exercise the daemon against a client that
 * can misbehave.
 */
export class TestClient {
  private socket: WebSocket | undefined;
  readonly received: ServerToClientMessage[] = [];
  closeCode: number | undefined;
  handshakeFailed = false;

  private waiters: { match(m: ServerToClientMessage): boolean; resolve(m: ServerToClientMessage): void }[] = [];
  private closeWaiters: (() => void)[] = [];

  static async open(port: number, headers?: Record<string, string>): Promise<TestClient> {
    const client = new TestClient();
    await client.connect(port, headers);
    return client;
  }

  private connect(port: number, headers?: Record<string, string>): Promise<void> {
    return new Promise((resolve) => {
      // The `ws` client rather than Node's global one, because these tests need
      // to forge request headers — `Origin` above all — and the WHATWG
      // WebSocket API deliberately offers no way to set them.
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
      this.socket = socket;

      socket.on("open", () => resolve());
      socket.on("error", () => {
        this.handshakeFailed = true;
        resolve();
      });
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as ServerToClientMessage;
        this.received.push(message);
        for (const waiter of [...this.waiters]) {
          if (!waiter.match(message)) continue;
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(message);
        }
      });
      socket.on("close", (code) => {
        this.closeCode = code;
        for (const resolveClose of this.closeWaiters) resolveClose();
        this.closeWaiters = [];
        resolve();
      });
    });
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.socket?.send(text);
  }

  next<K extends ServerToClientMessage["kind"]>(
    kind: K,
    predicate: (m: Extract<ServerToClientMessage, { kind: K }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerToClientMessage, { kind: K }>> {
    type Wanted = Extract<ServerToClientMessage, { kind: K }>;
    const already = this.received.find(
      (m): m is Wanted => m.kind === kind && predicate(m as Wanted),
    );
    if (already) return Promise.resolve(already);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${kind}; saw ${this.received.map((m) => m.kind).join(", ")}`)),
        timeoutMs,
      );
      this.waiters.push({
        match: (m) => m.kind === kind && predicate(m as Wanted),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Wanted);
        },
      });
    });
  }

  closed(timeoutMs = 5_000): Promise<void> {
    if (this.closeCode !== undefined || this.handshakeFailed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket never closed")), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.socket?.close();
  }
}

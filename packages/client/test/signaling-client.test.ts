import { describe, expect, it } from "vitest";
import { SignalingClient, type WebSocketLike } from "../src/signaling-client";

class MockWebSocket implements WebSocketLike {
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }

  receiveRaw(data: unknown): void {
    this.emit("message", { data });
  }

  error(): void {
    this.emit("error", {});
  }

  private emit(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (!set) {
      return;
    }
    for (const handler of set) {
      handler(payload);
    }
  }
}

describe("SignalingClient", () => {
  it("connects and stores session data", async () => {
    let socket: MockWebSocket | null = null;
    const client = new SignalingClient({
      wsBaseUrl: "wss://example.com/ws",
      roomId: "room-a",
      getJoinToken: () => "token-1",
      webSocketFactory: (url) => {
        socket = new MockWebSocket(url);
        queueMicrotask(() => socket?.open());
        return socket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    socket?.receive({
      type: "session.welcome",
      peerId: "peer-self",
      userId: "user-self",
      roomId: "room-a",
      resumeToken: "resume-1",
      resumeExpiresAt: Date.now() + 30_000,
      peers: [],
    });

    const welcome = await connecting;
    expect(welcome.peerId).toBe("peer-self");
    expect(client.peerId).toBe("peer-self");
    expect(socket?.url).toContain("/ws/room-a");
    expect(socket?.url).toContain("token=token-1");
  });

  it("resolves alias via request/response", async () => {
    let socket: MockWebSocket | null = null;
    const client = new SignalingClient({
      wsBaseUrl: "wss://example.com/ws",
      roomId: "room-a",
      getJoinToken: () => "token-1",
      webSocketFactory: (url) => {
        socket = new MockWebSocket(url);
        queueMicrotask(() => socket?.open());
        return socket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    socket?.receive({
      type: "session.welcome",
      peerId: "peer-self",
      userId: "user-self",
      roomId: "room-a",
      resumeToken: "resume-1",
      resumeExpiresAt: Date.now() + 30_000,
      peers: [],
    });
    await connecting;

    const resolving = client.resolveAlias("alice");
    const sent = socket?.sent.at(-1);
    expect(sent).toBeTruthy();
    const parsed = JSON.parse(sent as string) as { requestId: string };

    socket?.receive({
      type: "discovery.resolved",
      requestId: parsed.requestId,
      name: "alice",
      userId: "user-alice",
      peers: [
        {
          peerId: "peer-alice",
          userId: "user-alice",
          roomId: "room-a",
          name: "alice",
        },
      ],
    });

    const peers = await resolving;
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerId).toBe("peer-alice");
  });

  it("waits for recipient ack on signal send", async () => {
    let socket: MockWebSocket | null = null;
    const client = new SignalingClient({
      wsBaseUrl: "wss://example.com/ws",
      roomId: "room-a",
      getJoinToken: () => "token-1",
      webSocketFactory: (url) => {
        socket = new MockWebSocket(url);
        queueMicrotask(() => socket?.open());
        return socket;
      },
      deliveryAckTimeoutMs: 2_000,
    });

    const connecting = client.connect();
    await Promise.resolve();
    socket?.receive({
      type: "session.welcome",
      peerId: "peer-self",
      userId: "user-self",
      roomId: "room-a",
      resumeToken: "resume-1",
      resumeExpiresAt: Date.now() + 30_000,
      peers: [],
    });
    await connecting;

    const sending = client.sendSignal("peer-bob", {
      kind: "offer",
      description: { type: "offer", sdp: "v=0" },
    });

    const sent = socket?.sent.at(-1);
    expect(sent).toBeTruthy();
    const parsed = JSON.parse(sent as string) as { deliveryId: string };

    socket?.receive({
      type: "signal.acked",
      deliveryId: parsed.deliveryId,
      byPeerId: "peer-self",
      at: Date.now(),
    });

    socket?.receive({
      type: "signal.acked",
      deliveryId: parsed.deliveryId,
      byPeerId: "peer-bob",
      at: Date.now(),
    });

    const ack = await sending;
    expect(ack.deliveryId).toBe(parsed.deliveryId);
    expect(ack.ack.byPeerId).toBe("peer-bob");
  });

  it("handles Blob websocket payloads (browser style)", async () => {
    let socket: MockWebSocket | null = null;
    const client = new SignalingClient({
      wsBaseUrl: "wss://example.com/ws",
      roomId: "room-a",
      getJoinToken: () => "token-1",
      webSocketFactory: (url) => {
        socket = new MockWebSocket(url);
        queueMicrotask(() => socket?.open());
        return socket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    const payload = {
      type: "session.welcome",
      peerId: "peer-blob",
      userId: "user-blob",
      roomId: "room-a",
      resumeToken: "resume-blob",
      resumeExpiresAt: Date.now() + 30_000,
      peers: [],
    };
    socket?.receiveRaw(new Blob([JSON.stringify(payload)], { type: "application/json" }));

    const welcome = await connecting;
    expect(welcome.peerId).toBe("peer-blob");
    expect(client.peerId).toBe("peer-blob");
  });

  it("ignores stale socket events after reconnect", async () => {
    const sockets: MockWebSocket[] = [];
    const errors: Error[] = [];
    const disconnects: Array<{ code: number; reason: string }> = [];

    const client = new SignalingClient({
      wsBaseUrl: "wss://example.com/ws",
      roomId: "room-a",
      getJoinToken: () => "token-1",
      reconnect: {
        enabled: true,
        minDelayMs: 1,
        maxDelayMs: 1,
        jitterMs: 0,
      },
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    client.on("error", (error) => errors.push(error));
    client.on("disconnected", (event) => disconnects.push(event));

    const firstConnect = client.connect();
    await Promise.resolve();
    const socket1 = sockets[0];
    expect(socket1).toBeTruthy();
    socket1?.open();
    socket1?.receive({
      type: "session.welcome",
      peerId: "peer-1",
      userId: "user-1",
      roomId: "room-a",
      resumeToken: "resume-1",
      resumeExpiresAt: Date.now() + 30_000,
      peers: [],
    });
    await firstConnect;

    socket1?.close(1006, "");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const socket2 = sockets[1];
    expect(socket2).toBeTruthy();
    socket2?.open();
    socket2?.receive({
      type: "session.welcome",
      peerId: "peer-1",
      userId: "user-1",
      roomId: "room-a",
      resumeToken: "resume-2",
      resumeExpiresAt: Date.now() + 30_000,
      peers: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    socket1?.error();
    socket1?.receive({
      type: "error",
      code: "STALE",
      message: "stale socket event",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(disconnects).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(client.peerId).toBe("peer-1");
  });
});

#!/usr/bin/env node

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const roomId = process.env.ROOM_ID ?? `smoke-${crypto.randomUUID().slice(0, 8)}`;
const internalSecret = process.env.INTERNAL_API_SECRET ?? "";
const runId = crypto.randomUUID().slice(0, 8);

const wsBaseUrl = baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

let WebSocketCtor = globalThis.WebSocket;
if (!WebSocketCtor) {
  try {
    const wsModule = await import("ws");
    WebSocketCtor = wsModule.WebSocket;
  } catch {
    console.error("No WebSocket implementation found. Use Node 22+ or install ws.");
    process.exit(1);
  }
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function logInfo(message) {
  console.log(`[${new Date().toISOString()}] [run:${runId}] ${message}`);
}

function logStep(step, message) {
  logInfo(`[STEP ${step}] ${message}`);
}

function bindSocketEvent(socket, event, listener) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(event, listener);
    return;
  }
  throw new Error("Socket implementation must provide addEventListener or on");
}

function summarizeMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return String(payload);
  }

  switch (payload.type) {
    case "session.welcome":
      return `session.welcome peerId=${payload.peerId} userId=${payload.userId} peers=${payload.peers?.length ?? 0}`;
    case "presence.joined":
      return `presence.joined peerId=${payload.peer?.peerId} alias=${payload.peer?.name ?? "none"}`;
    case "presence.left":
      return `presence.left peerId=${payload.peerId}`;
    case "discovery.resolve":
      return `discovery.resolve requestId=${payload.requestId} name=${payload.name}`;
    case "discovery.resolved":
      return `discovery.resolved requestId=${payload.requestId} name=${payload.name} peers=${payload.peers?.length ?? 0}`;
    case "signal.send":
      return `signal.send deliveryId=${payload.deliveryId} toPeerId=${payload.toPeerId} kind=${payload.payload?.kind ?? "unknown"}`;
    case "signal.message":
      return `signal.message deliveryId=${payload.deliveryId} fromPeerId=${payload.fromPeerId} kind=${payload.payload?.kind ?? "unknown"}`;
    case "signal.ack":
      return `signal.ack deliveryId=${payload.deliveryId} toPeerId=${payload.toPeerId}`;
    case "signal.acked":
      return `signal.acked deliveryId=${payload.deliveryId} byPeerId=${payload.byPeerId}`;
    case "error":
      return `error code=${payload.code} message=${payload.message}`;
    default:
      return payload.type ? String(payload.type) : JSON.stringify(payload);
  }
}

async function issueToken(userId, name) {
  const headers = {
    "content-type": "application/json",
  };
  if (internalSecret) {
    headers["x-internal-secret"] = internalSecret;
    headers["x-dev-issuer-secret"] = internalSecret;
  }

  const response = await fetch(`${baseUrl}/token/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      userId,
      roomId,
      name,
      ttlSeconds: 120,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token issue failed (${response.status}): ${body}`);
  }

  const body = await response.json();
  logInfo(`[TOKEN] issued userId=${userId} alias=${name}`);
  return body.token;
}

class PeerSocket {
  constructor(label, token) {
    this.label = label;
    this.socket = new WebSocketCtor(`${wsBaseUrl}/ws/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`);
    this.messages = [];
    this.waiters = [];
    this.shuttingDown = false;

    bindSocketEvent(this.socket, "open", () => {
      logInfo(`[${this.label}] WS open`);
    });

    bindSocketEvent(this.socket, "close", (event) => {
      if (this.shuttingDown) {
        return;
      }
      const code = event?.code ?? "";
      const reason = event?.reason ?? "";
      logInfo(`[${this.label}] WS close code=${code} reason=${reason}`);
    });

    bindSocketEvent(this.socket, "error", () => {
      if (this.shuttingDown) {
        return;
      }
      logInfo(`[${this.label}] WS error`);
    });

    bindSocketEvent(this.socket, "message", (event) => {
      const payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString("utf8"));
      this.messages.push(payload);
      logInfo(`[${this.label}] << ${summarizeMessage(payload)}`);
      this.flushWaiters();
    });
  }

  waitFor(predicate, timeoutMs = 5000, description = "message") {
    logInfo(`[${this.label}] waiting for ${description} (timeout=${timeoutMs}ms)`);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`${this.label} timed out waiting for ${description}`));
      }, timeoutMs);

      const waiter = { predicate, resolve, reject, timeoutId };
      this.waiters.push(waiter);
      this.flushWaiters();
    });
  }

  flushWaiters() {
    for (const waiter of [...this.waiters]) {
      const foundIndex = this.messages.findIndex(waiter.predicate);
      if (foundIndex === -1) {
        continue;
      }
      const [message] = this.messages.splice(foundIndex, 1);
      clearTimeout(waiter.timeoutId);
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(message);
    }
  }

  send(payload) {
    logInfo(`[${this.label}] >> ${summarizeMessage(payload)}`);
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.shuttingDown = true;
    try {
      this.socket.close(1000, "done");
    } catch {
      // no-op
    }
    if (typeof this.socket.terminate === "function") {
      setTimeout(() => {
        try {
          this.socket.terminate();
        } catch {
          // no-op
        }
      }, 100);
    }
  }
}

async function main() {
  logInfo(`Smoke signaling start baseUrl=${baseUrl} roomId=${roomId}`);

  const runSuffix = crypto.randomUUID().slice(0, 6);
  const aliceUserId = `alice-${runSuffix}`;
  const bobUserId = `bob-${runSuffix}`;

  logStep(1, "Issuing short-lived join tokens");
  const aliceToken = await issueToken(aliceUserId, "alice");
  const bobToken = await issueToken(bobUserId, "bob");

  logStep(2, "Opening websocket sessions for ALICE and BOB");
  const alice = new PeerSocket("ALICE", aliceToken);
  const bob = new PeerSocket("BOB", bobToken);

  const aliceWelcome = await alice.waitFor((msg) => msg.type === "session.welcome", 5000, "session.welcome");
  const bobWelcome = await bob.waitFor((msg) => msg.type === "session.welcome", 5000, "session.welcome");

  logStep(3, "ALICE resolves alias 'bob'");
  const resolveReqId = createId("resolve");
  alice.send({ type: "discovery.resolve", requestId: resolveReqId, name: "bob" });

  const resolved = await alice.waitFor(
    (msg) => msg.type === "discovery.resolved" && msg.requestId === resolveReqId,
    5000,
    "discovery.resolved for bob",
  );

  if (!resolved.peers || resolved.peers.length !== 1) {
    throw new Error("Bob alias did not resolve to exactly one peer");
  }

  logStep(4, "ALICE sends synthetic offer; BOB receives and ACKs");
  const bobPeerId = resolved.peers[0].peerId;
  const deliveryId = createId("delivery");

  alice.send({
    type: "signal.send",
    deliveryId,
    toPeerId: bobPeerId,
    payload: {
      kind: "offer",
      description: { type: "offer", sdp: "v=0" },
    },
  });

  const signalMessage = await bob.waitFor(
    (msg) => msg.type === "signal.message" && msg.deliveryId === deliveryId,
    5000,
    "signal.message offer",
  );

  bob.send({
    type: "signal.ack",
    deliveryId,
    toPeerId: signalMessage.fromPeerId,
  });

  await alice.waitFor(
    (msg) => msg.type === "signal.acked" && msg.deliveryId === deliveryId && msg.byPeerId === bobWelcome.peerId,
    5000,
    "signal.acked from bob",
  );

  logStep(5, "Closing sockets and finalizing");
  alice.close();
  bob.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  logInfo("Smoke signaling check passed");
  logInfo(`[RESULT] ALICE peerId=${aliceWelcome.peerId} userId=${aliceWelcome.userId}`);
  logInfo(`[RESULT] BOB peerId=${bobWelcome.peerId} userId=${bobWelcome.userId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

#!/usr/bin/env node

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const roomId = process.env.ROOM_ID ?? "smoke-room";
const internalSecret = process.env.INTERNAL_API_SECRET ?? "";

if (!internalSecret) {
  console.error("INTERNAL_API_SECRET is required for /token/issue");
  process.exit(1);
}

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

async function issueToken(userId, name) {
  const response = await fetch(`${baseUrl}/token/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": internalSecret,
    },
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
  return body.token;
}

class PeerSocket {
  constructor(label, token) {
    this.label = label;
    this.socket = new WebSocketCtor(`${wsBaseUrl}/ws/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`);
    this.messages = [];
    this.waiters = [];

    this.socket.addEventListener("message", (event) => {
      const payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString("utf8"));
      this.messages.push(payload);
      this.flushWaiters();
    });
  }

  waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`${this.label} timed out waiting for message`));
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
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.socket.close(1000, "done");
  }
}

async function main() {
  const aliceToken = await issueToken("alice", "alice");
  const bobToken = await issueToken("bob", "bob");

  const alice = new PeerSocket("alice", aliceToken);
  const bob = new PeerSocket("bob", bobToken);

  const aliceWelcome = await alice.waitFor((msg) => msg.type === "session.welcome");
  const bobWelcome = await bob.waitFor((msg) => msg.type === "session.welcome");

  const resolveReqId = createId("resolve");
  alice.send({ type: "discovery.resolve", requestId: resolveReqId, name: "bob" });

  const resolved = await alice.waitFor(
    (msg) => msg.type === "discovery.resolved" && msg.requestId === resolveReqId,
    5000,
  );

  if (!resolved.peers || resolved.peers.length !== 1) {
    throw new Error("Bob alias did not resolve to exactly one peer");
  }

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
  );

  bob.send({
    type: "signal.ack",
    deliveryId,
    toPeerId: signalMessage.fromPeerId,
  });

  await alice.waitFor(
    (msg) => msg.type === "signal.acked" && msg.deliveryId === deliveryId && msg.byPeerId === bobWelcome.peerId,
    5000,
  );

  alice.close();
  bob.close();

  console.log("Smoke signaling check passed");
  console.log(`alice peerId=${aliceWelcome.peerId}`);
  console.log(`bob peerId=${bobWelcome.peerId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

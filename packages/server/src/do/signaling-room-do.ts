import type { Env } from "../types";
import {
  asClientMessage,
  newId,
  safeJsonParse,
  type ClientMessage,
  type PeerSummary,
  type ServerErrorMessage,
  type ServerMessage,
  type SignalPayload,
} from "../protocol";

const RESUME_TTL_MS = 30_000;
const DELIVERY_RETRY_INTERVAL_MS = 1_500;
const DELIVERY_MAX_ATTEMPTS = 12;
const DELIVERY_MAX_AGE_MS = 90_000;

interface SocketAttachment {
  peerId: string;
  userId: string;
  roomId: string;
  alias: string | null;
  resumeToken: string;
  resumeExpiresAt: number;
}

interface PeerRecord {
  peerId: string;
  userId: string;
  roomId: string;
  alias: string | null;
  resumeToken: string;
  resumeExpiresAt: number;
  connected: boolean;
  lastSeenAt: number;
}

interface ResumeRecord {
  token: string;
  peerId: string;
  userId: string;
  roomId: string;
  alias: string | null;
  expiresAt: number;
}

interface PendingDeliveryRecord {
  deliveryId: string;
  fromPeerId: string;
  fromUserId: string;
  toPeerId: string;
  payload: SignalPayload;
  sentAt: number;
  attempts: number;
  nextRetryAt: number;
  expiresAt: number;
}

function resumeStorageKey(token: string): string {
  return `resume:${token}`;
}

function pendingStorageKey(toPeerId: string, deliveryId: string): string {
  return `pending:${toPeerId}:${deliveryId}`;
}

function normalizeAlias(alias: string | null | undefined): string | null {
  if (!alias) {
    return null;
  }
  const trimmed = alias.trim().toLowerCase();
  if (trimmed.length < 2 || trimmed.length > 32) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function nowMs(): number {
  return Date.now();
}

export class SignalingRoomDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private hydrated = false;
  private readonly peers = new Map<string, PeerRecord>();
  private readonly sockets = new Map<string, WebSocket>();
  private readonly aliasToPeerId = new Map<string, string>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureHydrated();

    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const roomId = request.headers.get("x-auth-room-id");
    const userId = request.headers.get("x-auth-user-id");
    const aliasFromToken = normalizeAlias(request.headers.get("x-auth-name"));

    if (!roomId || !userId) {
      return new Response("Missing authentication headers", { status: 401 });
    }

    const url = new URL(request.url);
    const requestedResumeToken = url.searchParams.get("resumeToken");
    const previousConnection = requestedResumeToken
      ? await this.tryResumeByToken(requestedResumeToken, userId, roomId)
      : null;

    const wasConnected = previousConnection?.connected ?? false;
    const peer = previousConnection ?? this.createNewPeer(userId, roomId);
    const incomingAlias = aliasFromToken ?? peer.alias;

    if (this.sockets.has(peer.peerId)) {
      const oldSocket = this.sockets.get(peer.peerId);
      oldSocket?.close(1012, "superseded");
      this.sockets.delete(peer.peerId);
    }

    const nextResumeToken = newId("resume");
    const expiresAt = nowMs() + RESUME_TTL_MS;
    peer.resumeToken = nextResumeToken;
    peer.resumeExpiresAt = expiresAt;
    peer.connected = true;
    peer.lastSeenAt = nowMs();

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server, [peer.peerId]);

    this.sockets.set(peer.peerId, server);
    this.peers.set(peer.peerId, peer);

    if (incomingAlias) {
      const aliasError = this.assignAlias(peer.peerId, incomingAlias);
      if (aliasError) {
        this.sendError(server, aliasError.code, aliasError.message);
      }
    }

    this.persistSocketAttachment(peer.peerId);

    this.send(server, {
      type: "session.welcome",
      peerId: peer.peerId,
      userId: peer.userId,
      roomId: peer.roomId,
      resumeToken: peer.resumeToken,
      resumeExpiresAt: peer.resumeExpiresAt,
      peers: this.listConnectedPeers(peer.peerId),
    });

    if (!wasConnected) {
      this.broadcast(
        {
          type: "presence.joined",
          peer: this.toPeerSummary(peer),
        },
        peer.peerId,
      );
    }

    await this.replayPendingForPeer(peer.peerId);
    await this.scheduleAlarmAt(expiresAt);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, payload: string | ArrayBuffer): Promise<void> {
    await this.ensureHydrated();

    if (typeof payload !== "string") {
      this.sendError(ws, "BAD_MESSAGE", "Message must be a JSON string");
      return;
    }

    const parsed = safeJsonParse(payload);
    const message = parsed ? asClientMessage(parsed) : null;
    if (!message) {
      this.sendError(ws, "BAD_MESSAGE", "Malformed client message");
      return;
    }

    const peerId = this.peerIdForSocket(ws);
    if (!peerId) {
      this.sendError(ws, "UNBOUND_SOCKET", "Socket is not associated with a peer");
      return;
    }

    const peer = this.peers.get(peerId);
    if (!peer || !peer.connected) {
      this.sendError(ws, "SESSION_NOT_FOUND", "Peer is not connected");
      return;
    }

    peer.lastSeenAt = nowMs();

    switch (message.type) {
      case "heartbeat.ping": {
        this.send(ws, {
          type: "heartbeat.pong",
          ts: message.ts,
        });
        return;
      }
      case "discovery.claim": {
        const normalized = normalizeAlias(message.name);
        if (!normalized) {
          this.sendError(ws, "ALIAS_INVALID", "Alias must be 2-32 chars: [a-z0-9_.-]", message.requestId);
          return;
        }
        const aliasError = this.assignAlias(peerId, normalized);
        if (aliasError) {
          this.sendError(ws, aliasError.code, aliasError.message, message.requestId);
          return;
        }
        this.send(ws, {
          type: "discovery.claimed",
          name: normalized,
          userId: peer.userId,
          requestId: message.requestId,
        });
        this.broadcast(
          {
            type: "presence.joined",
            peer: this.toPeerSummary(peer),
          },
          peerId,
        );
        return;
      }
      case "discovery.resolve": {
        const normalized = normalizeAlias(message.name);
        if (!normalized) {
          this.sendError(ws, "ALIAS_INVALID", "Alias must be 2-32 chars: [a-z0-9_.-]", message.requestId);
          return;
        }
        const resolvedPeerId = this.aliasToPeerId.get(normalized);
        const target = resolvedPeerId ? this.peers.get(resolvedPeerId) : undefined;
        const peers = target && target.connected ? [this.toPeerSummary(target)] : [];
        this.send(ws, {
          type: "discovery.resolved",
          requestId: message.requestId,
          name: normalized,
          userId: target?.userId ?? "",
          peers,
        });
        return;
      }
      case "signal.send": {
        if (!this.peers.has(message.toPeerId)) {
          this.sendError(ws, "TARGET_NOT_FOUND", "Target peer is unknown", message.requestId);
          return;
        }

        const deliveryId = message.deliveryId ?? newId("delivery");
        const now = nowMs();
        const pending: PendingDeliveryRecord = {
          deliveryId,
          fromPeerId: peer.peerId,
          fromUserId: peer.userId,
          toPeerId: message.toPeerId,
          payload: message.payload,
          sentAt: now,
          attempts: 0,
          nextRetryAt: now,
          expiresAt: now + DELIVERY_MAX_AGE_MS,
        };

        await this.state.storage.put(pendingStorageKey(message.toPeerId, deliveryId), pending);
        await this.tryDeliverPending(pending);

        this.send(ws, {
          type: "signal.acked",
          deliveryId,
          byPeerId: peer.peerId,
          at: now,
        });

        await this.scheduleAlarmAt(now + DELIVERY_RETRY_INTERVAL_MS);
        return;
      }
      case "signal.ack": {
        const pendingKey = pendingStorageKey(peer.peerId, message.deliveryId);
        const pending = await this.state.storage.get<PendingDeliveryRecord>(pendingKey);
        if (!pending) {
          return;
        }

        await this.state.storage.delete(pendingKey);

        const senderSocket = this.sockets.get(pending.fromPeerId);
        if (senderSocket) {
          this.send(senderSocket, {
            type: "signal.acked",
            deliveryId: pending.deliveryId,
            byPeerId: peer.peerId,
            at: nowMs(),
          });
        }
        return;
      }
      default: {
        this.sendError(ws, "UNSUPPORTED", `Unsupported message type: ${(message as ClientMessage).type}`);
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ensureHydrated();
    await this.handleSocketDeparture(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.ensureHydrated();
    await this.handleSocketDeparture(ws);
  }

  async alarm(): Promise<void> {
    await this.ensureHydrated();
    const now = nowMs();
    let nextAlarm: number | null = null;

    const pendingEntries = await this.state.storage.list<PendingDeliveryRecord>({ prefix: "pending:" });
    for (const [key, record] of pendingEntries) {
      if (record.expiresAt <= now) {
        await this.state.storage.delete(key);
        continue;
      }

      if (record.nextRetryAt <= now) {
        if (record.attempts >= DELIVERY_MAX_ATTEMPTS) {
          await this.state.storage.delete(key);
          continue;
        }

        await this.tryDeliverPending(record);
      }

      nextAlarm = nextAlarm === null ? record.nextRetryAt : Math.min(nextAlarm, record.nextRetryAt);
      nextAlarm = Math.min(nextAlarm, record.expiresAt);
    }

    const resumeEntries = await this.state.storage.list<ResumeRecord>({ prefix: "resume:" });
    for (const [key, record] of resumeEntries) {
      if (record.expiresAt <= now) {
        await this.state.storage.delete(key);
        const peer = this.peers.get(record.peerId);
        if (peer && !peer.connected && peer.resumeToken === record.token) {
          if (peer.alias && this.aliasToPeerId.get(peer.alias) === peer.peerId) {
            this.aliasToPeerId.delete(peer.alias);
          }
          this.peers.delete(peer.peerId);
        }
        continue;
      }

      nextAlarm = nextAlarm === null ? record.expiresAt : Math.min(nextAlarm, record.expiresAt);
    }

    if (nextAlarm === null) {
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.state.storage.setAlarm(nextAlarm);
  }

  private createNewPeer(userId: string, roomId: string): PeerRecord {
    return {
      peerId: newId("peer"),
      userId,
      roomId,
      alias: null,
      resumeToken: newId("resume"),
      resumeExpiresAt: nowMs() + RESUME_TTL_MS,
      connected: false,
      lastSeenAt: nowMs(),
    };
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || !attachment.peerId) {
        ws.close(1011, "missing attachment");
        continue;
      }

      const peer: PeerRecord = {
        peerId: attachment.peerId,
        userId: attachment.userId,
        roomId: attachment.roomId,
        alias: attachment.alias,
        resumeToken: attachment.resumeToken,
        resumeExpiresAt: attachment.resumeExpiresAt,
        connected: true,
        lastSeenAt: nowMs(),
      };

      this.peers.set(peer.peerId, peer);
      this.sockets.set(peer.peerId, ws);
      if (peer.alias) {
        this.aliasToPeerId.set(peer.alias, peer.peerId);
      }
    }

    const resumeEntries = await this.state.storage.list<ResumeRecord>({ prefix: "resume:" });
    const now = nowMs();
    for (const [key, record] of resumeEntries) {
      if (record.expiresAt <= now) {
        await this.state.storage.delete(key);
        continue;
      }

      if (!this.peers.has(record.peerId)) {
        this.peers.set(record.peerId, {
          peerId: record.peerId,
          userId: record.userId,
          roomId: record.roomId,
          alias: record.alias,
          resumeToken: record.token,
          resumeExpiresAt: record.expiresAt,
          connected: false,
          lastSeenAt: now,
        });
      }

      if (record.alias && !this.aliasToPeerId.has(record.alias)) {
        this.aliasToPeerId.set(record.alias, record.peerId);
      }
    }

    this.hydrated = true;
  }

  private peerIdForSocket(ws: WebSocket): string | null {
    const tags = this.state.getTags(ws);
    if (tags.length > 0 && tags[0]) {
      return tags[0];
    }
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.peerId) {
      return attachment.peerId;
    }
    return null;
  }

  private listConnectedPeers(exceptPeerId?: string): PeerSummary[] {
    const out: PeerSummary[] = [];
    for (const peer of this.peers.values()) {
      if (!peer.connected) {
        continue;
      }
      if (exceptPeerId && peer.peerId === exceptPeerId) {
        continue;
      }
      out.push(this.toPeerSummary(peer));
    }
    return out;
  }

  private toPeerSummary(peer: PeerRecord): PeerSummary {
    return {
      peerId: peer.peerId,
      userId: peer.userId,
      roomId: peer.roomId,
      name: peer.alias,
    };
  }

  private assignAlias(
    peerId: string,
    alias: string,
  ): { code: string; message: string } | null {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return { code: "SESSION_NOT_FOUND", message: "Peer session not found" };
    }

    const claimedBy = this.aliasToPeerId.get(alias);
    if (claimedBy && claimedBy !== peerId) {
      return { code: "ALIAS_TAKEN", message: "Alias already claimed in this room" };
    }

    if (peer.alias && this.aliasToPeerId.get(peer.alias) === peerId) {
      this.aliasToPeerId.delete(peer.alias);
    }

    peer.alias = alias;
    this.aliasToPeerId.set(alias, peerId);
    this.persistSocketAttachment(peerId);
    return null;
  }

  private persistSocketAttachment(peerId: string): void {
    const peer = this.peers.get(peerId);
    const ws = this.sockets.get(peerId);
    if (!peer || !ws) {
      return;
    }
    const attachment: SocketAttachment = {
      peerId: peer.peerId,
      userId: peer.userId,
      roomId: peer.roomId,
      alias: peer.alias,
      resumeToken: peer.resumeToken,
      resumeExpiresAt: peer.resumeExpiresAt,
    };
    ws.serializeAttachment(attachment);
  }

  private async tryResumeByToken(token: string, userId: string, roomId: string): Promise<PeerRecord | null> {
    const key = resumeStorageKey(token);
    const record = await this.state.storage.get<ResumeRecord>(key);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= nowMs()) {
      await this.state.storage.delete(key);
      return null;
    }
    if (record.userId !== userId || record.roomId !== roomId) {
      return null;
    }

    await this.state.storage.delete(key);

    const peer = this.peers.get(record.peerId) ?? {
      peerId: record.peerId,
      userId: record.userId,
      roomId: record.roomId,
      alias: record.alias,
      resumeToken: record.token,
      resumeExpiresAt: record.expiresAt,
      connected: false,
      lastSeenAt: nowMs(),
    };

    peer.alias = record.alias;
    peer.userId = record.userId;
    peer.roomId = record.roomId;
    peer.resumeToken = record.token;
    peer.resumeExpiresAt = record.expiresAt;

    return peer;
  }

  private async handleSocketDeparture(ws: WebSocket): Promise<void> {
    const peerId = this.peerIdForSocket(ws);
    if (!peerId) {
      return;
    }

    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }

    this.sockets.delete(peerId);
    if (!peer.connected) {
      return;
    }

    peer.connected = false;
    peer.lastSeenAt = nowMs();

    const resumeRecord: ResumeRecord = {
      token: peer.resumeToken,
      peerId: peer.peerId,
      userId: peer.userId,
      roomId: peer.roomId,
      alias: peer.alias,
      expiresAt: peer.resumeExpiresAt,
    };

    await this.state.storage.put(resumeStorageKey(peer.resumeToken), resumeRecord);
    await this.scheduleAlarmAt(peer.resumeExpiresAt);

    this.broadcast({
      type: "presence.left",
      peerId: peer.peerId,
      userId: peer.userId,
    });
  }

  private async tryDeliverPending(record: PendingDeliveryRecord): Promise<void> {
    const now = nowMs();
    if (record.expiresAt <= now) {
      await this.state.storage.delete(pendingStorageKey(record.toPeerId, record.deliveryId));
      return;
    }

    const recipient = this.sockets.get(record.toPeerId);
    if (recipient) {
      this.send(recipient, {
        type: "signal.message",
        deliveryId: record.deliveryId,
        fromPeerId: record.fromPeerId,
        fromUserId: record.fromUserId,
        toPeerId: record.toPeerId,
        payload: record.payload,
        sentAt: record.sentAt,
      });
      record.attempts += 1;
    }

    record.nextRetryAt = now + DELIVERY_RETRY_INTERVAL_MS;
    await this.state.storage.put(pendingStorageKey(record.toPeerId, record.deliveryId), record);
  }

  private async replayPendingForPeer(peerId: string): Promise<void> {
    const pendingEntries = await this.state.storage.list<PendingDeliveryRecord>({
      prefix: `pending:${peerId}:`,
    });

    for (const [key, record] of pendingEntries) {
      if (record.expiresAt <= nowMs()) {
        await this.state.storage.delete(key);
        continue;
      }
      await this.tryDeliverPending(record);
    }
  }

  private async scheduleAlarmAt(at: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || at < current) {
      await this.state.storage.setAlarm(at);
    }
  }

  private send(socket: WebSocket, payload: ServerMessage): void {
    socket.send(JSON.stringify(payload));
  }

  private sendError(ws: WebSocket, code: string, message: string, requestId?: string): void {
    const payload: ServerErrorMessage = {
      type: "error",
      code,
      message,
      requestId,
    };
    this.send(ws, payload);
  }

  private broadcast(payload: ServerMessage, exceptPeerId?: string): void {
    const message = JSON.stringify(payload);
    for (const [peerId, socket] of this.sockets.entries()) {
      if (exceptPeerId && peerId === exceptPeerId) {
        continue;
      }
      socket.send(message);
    }
  }
}

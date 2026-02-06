export interface SignalPayload {
  kind: "offer" | "answer" | "ice" | "renegotiate" | "bye";
  description?: Record<string, unknown>;
  candidate?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface PeerSummary {
  peerId: string;
  userId: string;
  roomId: string;
  name: string | null;
}

export interface SessionWelcomeMessage {
  type: "session.welcome";
  peerId: string;
  userId: string;
  roomId: string;
  resumeToken: string;
  resumeExpiresAt: number;
  peers: PeerSummary[];
}

export interface PresenceJoinedMessage {
  type: "presence.joined";
  peer: PeerSummary;
}

export interface PresenceLeftMessage {
  type: "presence.left";
  peerId: string;
  userId: string;
}

export interface SignalMessage {
  type: "signal.message";
  deliveryId: string;
  fromPeerId: string;
  fromUserId: string;
  toPeerId: string;
  payload: SignalPayload;
  sentAt: number;
}

export interface SignalAckedMessage {
  type: "signal.acked";
  deliveryId: string;
  byPeerId: string;
  at: number;
}

export interface DiscoveryClaimedMessage {
  type: "discovery.claimed";
  name: string;
  userId: string;
  requestId?: string;
}

export interface DiscoveryResolvedMessage {
  type: "discovery.resolved";
  requestId?: string;
  name: string;
  userId: string;
  peers: PeerSummary[];
}

export interface HeartbeatPongMessage {
  type: "heartbeat.pong";
  ts: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
  requestId?: string;
}

export type ServerMessage =
  | SessionWelcomeMessage
  | PresenceJoinedMessage
  | PresenceLeftMessage
  | SignalMessage
  | SignalAckedMessage
  | DiscoveryClaimedMessage
  | DiscoveryResolvedMessage
  | HeartbeatPongMessage
  | ErrorMessage;

export interface BaseClientMessage {
  type: string;
  requestId?: string;
}

export interface SignalSendMessage extends BaseClientMessage {
  type: "signal.send";
  toPeerId: string;
  payload: SignalPayload;
  deliveryId?: string;
}

export interface SignalAckMessage extends BaseClientMessage {
  type: "signal.ack";
  deliveryId: string;
  toPeerId: string;
}

export interface DiscoveryClaimMessage extends BaseClientMessage {
  type: "discovery.claim";
  name: string;
}

export interface DiscoveryResolveMessage extends BaseClientMessage {
  type: "discovery.resolve";
  name: string;
}

export interface HeartbeatPingMessage extends BaseClientMessage {
  type: "heartbeat.ping";
  ts: number;
}

export type ClientMessage =
  | SignalSendMessage
  | SignalAckMessage
  | DiscoveryClaimMessage
  | DiscoveryResolveMessage
  | HeartbeatPingMessage;

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseServerMessage(value: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.type !== "string") {
      return null;
    }
    return candidate as unknown as ServerMessage;
  } catch {
    return null;
  }
}

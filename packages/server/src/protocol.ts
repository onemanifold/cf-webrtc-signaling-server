export interface ClientBaseMessage {
  type: string;
  requestId?: string;
}

export interface SignalPayload {
  kind: "offer" | "answer" | "ice" | "renegotiate" | "bye";
  description?: Record<string, unknown>;
  candidate?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ClientSignalSendMessage extends ClientBaseMessage {
  type: "signal.send";
  deliveryId?: string;
  toPeerId: string;
  payload: SignalPayload;
}

export interface ClientSignalAckMessage extends ClientBaseMessage {
  type: "signal.ack";
  deliveryId: string;
  toPeerId: string;
}

export interface ClientDiscoveryClaimMessage extends ClientBaseMessage {
  type: "discovery.claim";
  name: string;
}

export interface ClientDiscoveryResolveMessage extends ClientBaseMessage {
  type: "discovery.resolve";
  name: string;
}

export interface ClientHeartbeatPingMessage extends ClientBaseMessage {
  type: "heartbeat.ping";
  ts: number;
}

export type ClientMessage =
  | ClientSignalSendMessage
  | ClientSignalAckMessage
  | ClientDiscoveryClaimMessage
  | ClientDiscoveryResolveMessage
  | ClientHeartbeatPingMessage;

export interface PeerSummary {
  peerId: string;
  userId: string;
  roomId: string;
  name: string | null;
}

export interface ServerSessionWelcomeMessage {
  type: "session.welcome";
  peerId: string;
  userId: string;
  roomId: string;
  resumeToken: string;
  resumeExpiresAt: number;
  peers: PeerSummary[];
}

export interface ServerPresenceJoinedMessage {
  type: "presence.joined";
  peer: PeerSummary;
}

export interface ServerPresenceLeftMessage {
  type: "presence.left";
  peerId: string;
  userId: string;
}

export interface ServerSignalMessage {
  type: "signal.message";
  deliveryId: string;
  fromPeerId: string;
  fromUserId: string;
  toPeerId: string;
  payload: SignalPayload;
  sentAt: number;
}

export interface ServerSignalAckedMessage {
  type: "signal.acked";
  deliveryId: string;
  byPeerId: string;
  at: number;
}

export interface ServerDiscoveryClaimedMessage {
  type: "discovery.claimed";
  name: string;
  userId: string;
  requestId?: string;
}

export interface ServerDiscoveryResolvedMessage {
  type: "discovery.resolved";
  requestId?: string;
  name: string;
  userId: string;
  peers: PeerSummary[];
}

export interface ServerHeartbeatPongMessage {
  type: "heartbeat.pong";
  ts: number;
}

export interface ServerErrorMessage {
  type: "error";
  code: string;
  message: string;
  requestId?: string;
}

export type ServerMessage =
  | ServerSessionWelcomeMessage
  | ServerPresenceJoinedMessage
  | ServerPresenceLeftMessage
  | ServerSignalMessage
  | ServerSignalAckedMessage
  | ServerDiscoveryClaimedMessage
  | ServerDiscoveryResolvedMessage
  | ServerHeartbeatPongMessage
  | ServerErrorMessage;

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function asClientMessage(value: unknown): ClientMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== "string") {
    return null;
  }
  return candidate as unknown as ClientMessage;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

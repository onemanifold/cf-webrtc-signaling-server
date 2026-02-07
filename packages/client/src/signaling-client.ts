import { TypedEventEmitter } from "./event-emitter";
import {
  createId,
  parseServerMessage,
  type ClientMessage,
  type DiscoveryClaimedMessage,
  type DiscoveryResolvedMessage,
  type ErrorMessage,
  type PeerSummary,
  type ServerMessage,
  type SessionWelcomeMessage,
  type SignalAckedMessage,
  type SignalMessage,
  type SignalPayload,
} from "./protocol";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ReconnectOptions {
  enabled?: boolean;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
}

export interface SignalingClientOptions {
  wsBaseUrl: string;
  roomId: string;
  getJoinToken: () => Promise<string> | string;
  alias?: string;
  httpBaseUrl?: string;
  webSocketFactory?: WebSocketFactory;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  deliveryAckTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  reconnect?: ReconnectOptions;
}

export interface TurnCredentialsResponse {
  iceServers: Array<Record<string, unknown>>;
  ttlSeconds: number;
  rateLimit: {
    allowed: boolean;
    remaining: number;
    resetAt: number;
  };
}

export interface DeliveryAckResult {
  deliveryId: string;
  ack: SignalAckedMessage;
}

interface RequestWaiter {
  resolve: (value: ServerMessage) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface DeliveryWaiter {
  toPeerId: string;
  resolve: (value: DeliveryAckResult) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface SignalingEvents {
  connected: SessionWelcomeMessage;
  reconnected: SessionWelcomeMessage;
  disconnected: { code: number; reason: string };
  error: Error;
  presenceJoined: PeerSummary;
  presenceLeft: { peerId: string; userId: string };
  signal: SignalMessage;
  signalAcked: SignalAckedMessage;
  aliasClaimed: DiscoveryClaimedMessage;
  aliasResolved: DiscoveryResolvedMessage;
}

function nowMs(): number {
  return Date.now();
}

function cleanBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

export class SignalingClient {
  private readonly options: SignalingClientOptions;
  private readonly events = new TypedEventEmitter<SignalingEvents>();
  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<SessionWelcomeMessage> | null = null;
  private connectResolve: ((value: SessionWelcomeMessage) => void) | null = null;
  private connectReject: ((reason: Error) => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = true;
  private requestWaiters = new Map<string, RequestWaiter>();
  private deliveryWaiters = new Map<string, DeliveryWaiter>();

  peerId: string | null = null;
  userId: string | null = null;
  resumeToken: string | null = null;

  constructor(options: SignalingClientOptions) {
    this.options = options;
  }

  on<TKey extends keyof SignalingEvents>(event: TKey, handler: (payload: SignalingEvents[TKey]) => void): () => void {
    return this.events.on(event, handler);
  }

  async connect(): Promise<SessionWelcomeMessage> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.shouldReconnect = true;
    const pending = new Promise<SessionWelcomeMessage>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.connectPromise = pending;

    try {
      await this.openSocket();
      return await pending;
    } catch (error) {
      this.resetConnectPromise();
      throw error;
    }
  }

  close(code = 1000, reason = "client-close"): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close(code, reason);
    }
    this.socket = null;
    this.resetConnectPromise();
    for (const [requestId, waiter] of this.requestWaiters.entries()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(`Request ${requestId} cancelled because socket closed`));
      this.requestWaiters.delete(requestId);
    }
    for (const [deliveryId, waiter] of this.deliveryWaiters.entries()) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(`Delivery ${deliveryId} cancelled because socket closed`));
      this.deliveryWaiters.delete(deliveryId);
    }
  }

  async claimAlias(name: string): Promise<DiscoveryClaimedMessage> {
    const response = await this.sendRequest<DiscoveryClaimedMessage>({
      type: "discovery.claim",
      name,
    });
    return response;
  }

  async resolveAlias(name: string): Promise<PeerSummary[]> {
    const response = await this.sendRequest<DiscoveryResolvedMessage>({
      type: "discovery.resolve",
      name,
    });
    return response.peers;
  }

  async sendSignal(
    toPeerId: string,
    payload: SignalPayload,
    options: { deliveryId?: string; waitForPeerAck?: boolean } = {},
  ): Promise<DeliveryAckResult | { deliveryId: string }> {
    const deliveryId = options.deliveryId ?? createId("delivery");
    const waitForPeerAck = options.waitForPeerAck ?? true;

    if (waitForPeerAck) {
      const timeoutMs = this.options.deliveryAckTimeoutMs ?? 15_000;
      const resultPromise = new Promise<DeliveryAckResult>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.deliveryWaiters.delete(deliveryId);
          reject(new Error(`Timed out waiting for peer ack: ${deliveryId}`));
        }, timeoutMs);

        this.deliveryWaiters.set(deliveryId, {
          toPeerId,
          resolve,
          reject,
          timeoutId,
        });
      });

      this.send({
        type: "signal.send",
        toPeerId,
        payload,
        deliveryId,
      });

      return resultPromise;
    }

    this.send({
      type: "signal.send",
      toPeerId,
      payload,
      deliveryId,
    });

    return { deliveryId };
  }

  async fetchTurnCredentials(): Promise<TurnCredentialsResponse> {
    const token = await this.options.getJoinToken();
    const base = this.options.httpBaseUrl
      ? cleanBaseUrl(this.options.httpBaseUrl)
      : cleanBaseUrl(this.options.wsBaseUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:")).replace(/\/ws$/, "");

    const response = await fetch(`${base}/turn-credentials?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      throw new Error(`ICE credentials request failed (${response.status})`);
    }
    return (await response.json()) as TurnCredentialsResponse;
  }

  private async openSocket(): Promise<void> {
    const token = await this.options.getJoinToken();
    const base = cleanBaseUrl(this.options.wsBaseUrl);
    const params = new URLSearchParams({ token });
    if (this.resumeToken) {
      params.set("resumeToken", this.resumeToken);
    }
    const url = `${base}/${encodeURIComponent(this.options.roomId)}?${params.toString()}`;

    const previousSocket = this.socket;
    const socket = this.makeSocket(url);
    this.socket = socket;
    if (previousSocket && previousSocket !== socket && previousSocket.readyState <= 1) {
      previousSocket.close(1012, "superseded");
    }

    this.bindSocketHandlers(socket);
  }

  private bindSocketHandlers(socket: WebSocketLike): void {
    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? 20_000;
    const handshakeWatchdog = setTimeout(() => {
      if (!this.isCurrentSocket(socket)) {
        return;
      }
      if (socket.readyState !== 0) {
        return;
      }
      this.events.emit("error", new Error(`WebSocket handshake timed out (${handshakeTimeoutMs}ms)`));
      this.handleSocketClosed(socket, 1006, "handshake-timeout");
      try {
        socket.close(1000, "handshake-timeout");
      } catch {
        // no-op
      }
    }, handshakeTimeoutMs);

    const clearHandshakeWatchdog = () => {
      clearTimeout(handshakeWatchdog);
    };

    this.onSocketEvent(socket, "open", () => {
      if (!this.isCurrentSocket(socket)) {
        return;
      }
      clearHandshakeWatchdog();
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    });

    this.onSocketEvent(socket, "message", (event) => {
      if (!this.isCurrentSocket(socket)) {
        return;
      }
      void this.handleIncomingMessage(event);
    });

    this.onSocketEvent(socket, "error", () => {
      if (!this.isCurrentSocket(socket)) {
        return;
      }
      this.events.emit("error", new Error("WebSocket error"));
    });

    this.onSocketEvent(socket, "close", (event) => {
      if (!this.isCurrentSocket(socket)) {
        return;
      }
      clearHandshakeWatchdog();
      const code = this.extractCloseCode(event);
      const reason = this.extractCloseReason(event);
      this.handleSocketClosed(socket, code, reason);
    });
  }

  private isCurrentSocket(socket: WebSocketLike): boolean {
    return this.socket === socket;
  }

  private handleSocketClosed(socket: WebSocketLike, code: number, reason: string): void {
    if (!this.isCurrentSocket(socket)) {
      return;
    }

    this.stopHeartbeat();
    this.socket = null;

    this.events.emit("disconnected", { code, reason });

    const shouldAttemptReconnect = this.shouldReconnect && (this.options.reconnect?.enabled ?? true);
    if (this.connectReject && !this.peerId && !shouldAttemptReconnect) {
      this.connectReject(new Error(`WebSocket closed before session established (${code})`));
      this.resetConnectPromise();
    }

    if (shouldAttemptReconnect) {
      this.scheduleReconnect();
    }
  }

  private onSocketEvent(socket: WebSocketLike, event: string, handler: (...args: unknown[]) => void): void {
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener(event, handler);
      return;
    }
    if (typeof socket.on === "function") {
      socket.on(event, handler);
      return;
    }
    throw new Error("Socket implementation must provide addEventListener or on");
  }

  private async handleIncomingMessage(event: unknown): Promise<void> {
    const data = await this.extractMessageData(event);
    if (!data) {
      return;
    }
    const message = parseServerMessage(data);
    if (!message) {
      this.events.emit("error", new Error("Malformed server message"));
      return;
    }
    await this.handleServerMessage(message);
  }

  private async extractMessageData(event: unknown): Promise<string | null> {
    if (typeof event === "string") {
      return event;
    }

    if (event && typeof event === "object") {
      const candidate = event as Record<string, unknown>;
      const data = candidate.data;
      if (typeof data === "string") {
        return data;
      }
      if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(data);
      }
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data);
      }
      if (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "function") {
        try {
          return await (data as Blob).text();
        } catch {
          return null;
        }
      }
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
        return data.toString("utf8");
      }
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(event)) {
      return event.toString("utf8");
    }

    return null;
  }

  private extractCloseCode(event: unknown): number {
    if (!event || typeof event !== "object") {
      return 1006;
    }
    const code = (event as Record<string, unknown>).code;
    return typeof code === "number" ? code : 1006;
  }

  private extractCloseReason(event: unknown): string {
    if (!event || typeof event !== "object") {
      return "";
    }
    const reason = (event as Record<string, unknown>).reason;
    return typeof reason === "string" ? reason : "";
  }

  private async handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "session.welcome": {
        const previousPeerId = this.peerId;
        this.peerId = message.peerId;
        this.userId = message.userId;
        this.resumeToken = message.resumeToken;

        const resolver = this.connectResolve;
        if (resolver) {
          resolver(message);
          this.resetConnectPromise(false);
        }

        if (this.options.alias) {
          try {
            await this.claimAlias(this.options.alias);
          } catch (error) {
            this.events.emit("error", error as Error);
          }
        }

        if (previousPeerId && previousPeerId === message.peerId) {
          this.events.emit("reconnected", message);
        } else {
          this.events.emit("connected", message);
        }
        return;
      }
      case "presence.joined": {
        this.events.emit("presenceJoined", message.peer);
        return;
      }
      case "presence.left": {
        this.events.emit("presenceLeft", { peerId: message.peerId, userId: message.userId });
        return;
      }
      case "signal.message": {
        this.events.emit("signal", message);
        this.send({
          type: "signal.ack",
          deliveryId: message.deliveryId,
          toPeerId: message.fromPeerId,
        });
        return;
      }
      case "signal.acked": {
        this.events.emit("signalAcked", message);
        const waiter = this.deliveryWaiters.get(message.deliveryId);
        if (waiter && waiter.toPeerId === message.byPeerId) {
          clearTimeout(waiter.timeoutId);
          waiter.resolve({
            deliveryId: message.deliveryId,
            ack: message,
          });
          this.deliveryWaiters.delete(message.deliveryId);
        }
        return;
      }
      case "discovery.claimed": {
        if (message.requestId) {
          this.resolveRequest(message.requestId, message);
        }
        this.events.emit("aliasClaimed", message);
        return;
      }
      case "discovery.resolved": {
        if (message.requestId) {
          this.resolveRequest(message.requestId, message);
        }
        this.events.emit("aliasResolved", message);
        return;
      }
      case "heartbeat.pong": {
        return;
      }
      case "error": {
        if (message.requestId) {
          this.rejectRequest(message.requestId, new Error(`${message.code}: ${message.message}`));
          return;
        }
        this.events.emit("error", new Error(`${message.code}: ${message.message}`));
      }
    }
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("Socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  private async sendRequest<TResponse extends ServerMessage>(request: ClientMessage): Promise<TResponse> {
    const requestId = createId("req");
    const timeoutMs = this.options.requestTimeoutMs ?? 8_000;

    const responsePromise = new Promise<ServerMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.requestWaiters.delete(requestId);
        reject(new Error(`Request timed out: ${request.type}`));
      }, timeoutMs);
      this.requestWaiters.set(requestId, {
        resolve,
        reject,
        timeoutId,
      });
    });

    this.send({ ...request, requestId });

    const response = await responsePromise;
    return response as TResponse;
  }

  private resolveRequest(requestId: string, message: ServerMessage): void {
    const waiter = this.requestWaiters.get(requestId);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timeoutId);
    waiter.resolve(message);
    this.requestWaiters.delete(requestId);
  }

  private rejectRequest(requestId: string, error: Error): void {
    const waiter = this.requestWaiters.get(requestId);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timeoutId);
    waiter.reject(error);
    this.requestWaiters.delete(requestId);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = this.options.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) {
        return;
      }
      this.send({
        type: "heartbeat.ping",
        ts: nowMs(),
      });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const minDelay = this.options.reconnect?.minDelayMs ?? 500;
    const maxDelay = this.options.reconnect?.maxDelayMs ?? 12_000;
    const jitter = this.options.reconnect?.jitterMs ?? 250;
    const exponential = Math.min(maxDelay, minDelay * Math.pow(2, this.reconnectAttempt));
    const delay = exponential + Math.floor(Math.random() * jitter);

    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(async () => {
      if (!this.shouldReconnect) {
        return;
      }
      if (this.socket && this.socket.readyState <= 1) {
        return;
      }
      try {
        await this.openSocket();
      } catch (error) {
        this.events.emit("error", error as Error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private makeSocket(url: string): WebSocketLike {
    if (this.options.webSocketFactory) {
      return this.options.webSocketFactory(url);
    }

    const GlobalWs = (globalThis as unknown as { WebSocket?: new (wsUrl: string) => WebSocketLike }).WebSocket;
    if (!GlobalWs) {
      throw new Error("No WebSocket implementation found. Provide webSocketFactory in Node.");
    }

    return new GlobalWs(url);
  }

  private resetConnectPromise(clearPeer = true): void {
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    if (clearPeer) {
      this.peerId = null;
      this.userId = null;
    }
  }
}

import { TypedEventEmitter } from "./event-emitter";
import type { PeerSummary, SignalMessage, SignalPayload } from "./protocol";
import { SignalingClient } from "./signaling-client";

interface PeerLink {
  peerId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  dataChannels: Set<RTCDataChannel>;
  pendingRemoteCandidates: Array<RTCIceCandidateInit | null>;
}

interface LocalTrackBinding {
  track: MediaStreamTrack;
  streams: MediaStream[];
}

interface MeshEvents {
  peerConnected: { peerId: string; state: RTCPeerConnectionState };
  peerDisconnected: { peerId: string; state: RTCPeerConnectionState };
  track: { peerId: string; event: RTCTrackEvent };
  dataChannel: { peerId: string; channel: RTCDataChannel };
  signal: { peerId: string; payload: SignalPayload };
  error: Error;
}

export interface MeshClientOptions {
  signaling: SignalingClient;
  rtcConfiguration?: RTCConfiguration;
  dataChannelLabel?: string;
  autoCreateDataChannel?: boolean;
}

export class WebRTCMeshClient {
  private readonly signaling: SignalingClient;
  private readonly options: MeshClientOptions;
  private readonly events = new TypedEventEmitter<MeshEvents>();
  private readonly peers = new Map<string, PeerLink>();
  private readonly localTracks: LocalTrackBinding[] = [];

  constructor(options: MeshClientOptions) {
    this.options = options;
    this.signaling = options.signaling;

    this.signaling.on("connected", (welcome) => {
      this.syncPeers(welcome.peers);
    });

    this.signaling.on("reconnected", (welcome) => {
      this.syncPeers(welcome.peers);
    });

    this.signaling.on("presenceJoined", (peer) => {
      this.onPeerJoined(peer);
    });

    this.signaling.on("presenceLeft", (peer) => {
      this.closePeer(peer.peerId);
    });

    this.signaling.on("signal", (message) => {
      void this.handleSignalMessage(message);
    });

    this.signaling.on("error", (error) => {
      this.events.emit("error", error);
    });
  }

  on<TKey extends keyof MeshEvents>(event: TKey, handler: (payload: MeshEvents[TKey]) => void): () => void {
    return this.events.on(event, handler);
  }

  async start(): Promise<void> {
    const welcome = await this.signaling.connect();
    this.syncPeers(welcome.peers);
  }

  stop(): void {
    for (const peerId of this.peers.keys()) {
      this.closePeer(peerId);
    }
    this.signaling.close();
  }

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): void {
    this.localTracks.push({ track, streams });
    for (const link of this.peers.values()) {
      link.pc.addTrack(track, ...streams);
    }
  }

  removeTrack(track: MediaStreamTrack): void {
    const next = this.localTracks.filter((binding) => binding.track !== track);
    this.localTracks.length = 0;
    this.localTracks.push(...next);

    for (const link of this.peers.values()) {
      const sender = link.pc.getSenders().find((candidate) => candidate.track === track);
      if (sender) {
        link.pc.removeTrack(sender);
      }
    }
  }

  createDataChannel(peerId: string, label = this.options.dataChannelLabel ?? "mesh"): RTCDataChannel {
    const link = this.ensurePeer(peerId);
    const channel = link.pc.createDataChannel(label);
    this.attachDataChannel(link, channel);
    return channel;
  }

  sendData(peerId: string, data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    const link = this.peers.get(peerId);
    if (!link) {
      throw new Error(`Peer not found: ${peerId}`);
    }

    for (const channel of link.dataChannels.values()) {
      if (channel.readyState === "open") {
        this.sendOnChannel(channel, data);
      }
    }
  }

  broadcastData(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    for (const link of this.peers.values()) {
      for (const channel of link.dataChannels.values()) {
        if (channel.readyState === "open") {
          this.sendOnChannel(channel, data);
        }
      }
    }
  }

  getPeerConnection(peerId: string): RTCPeerConnection | null {
    return this.peers.get(peerId)?.pc ?? null;
  }

  private onPeerJoined(peer: PeerSummary): void {
    if (!this.signaling.peerId || peer.peerId === this.signaling.peerId) {
      return;
    }

    const link = this.ensurePeer(peer.peerId);
    if ((this.options.autoCreateDataChannel ?? true) && this.shouldInitiate(peer.peerId)) {
      if (link.dataChannels.size === 0) {
        const channel = link.pc.createDataChannel(this.options.dataChannelLabel ?? "mesh");
        this.attachDataChannel(link, channel);
      }
    }
  }

  private syncPeers(peers: PeerSummary[]): void {
    const expected = new Set(peers.map((peer) => peer.peerId));

    for (const peer of peers) {
      if (this.signaling.peerId && peer.peerId === this.signaling.peerId) {
        continue;
      }

      const link = this.ensurePeer(peer.peerId);
      if ((this.options.autoCreateDataChannel ?? true) && this.shouldInitiate(peer.peerId)) {
        if (link.dataChannels.size === 0) {
          const channel = link.pc.createDataChannel(this.options.dataChannelLabel ?? "mesh");
          this.attachDataChannel(link, channel);
        }
      }
    }

    for (const peerId of this.peers.keys()) {
      if (!expected.has(peerId)) {
        this.closePeer(peerId);
      }
    }
  }

  private ensurePeer(peerId: string): PeerLink {
    const existing = this.peers.get(peerId);
    if (existing) {
      return existing;
    }

    const pc = new RTCPeerConnection(this.options.rtcConfiguration);
    const link: PeerLink = {
      peerId,
      pc,
      polite: this.isPolite(peerId),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      dataChannels: new Set<RTCDataChannel>(),
      pendingRemoteCandidates: [],
    };

    pc.onicecandidate = (event) => {
      void this.signaling
        .sendSignal(peerId, {
          kind: "ice",
          candidate: event.candidate ? (event.candidate.toJSON() as Record<string, unknown>) : null,
        })
        .catch((error) => this.events.emit("error", error as Error));
    };

    pc.ontrack = (event) => {
      this.events.emit("track", { peerId, event });
    };

    pc.ondatachannel = (event) => {
      this.attachDataChannel(link, event.channel);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        this.events.emit("peerConnected", { peerId, state });
      }
      if (state === "failed" || state === "disconnected" || state === "closed") {
        this.events.emit("peerDisconnected", { peerId, state });
      }
    };

    pc.onnegotiationneeded = () => {
      void this.negotiate(link);
    };

    for (const binding of this.localTracks) {
      pc.addTrack(binding.track, ...binding.streams);
    }

    this.peers.set(peerId, link);
    return link;
  }

  private attachDataChannel(link: PeerLink, channel: RTCDataChannel): void {
    link.dataChannels.add(channel);
    channel.onclose = () => {
      link.dataChannels.delete(channel);
    };
    this.events.emit("dataChannel", { peerId: link.peerId, channel });
  }

  private async negotiate(link: PeerLink): Promise<void> {
    try {
      link.makingOffer = true;
      await link.pc.setLocalDescription();

      if (!link.pc.localDescription) {
        return;
      }

      await this.signaling.sendSignal(
        link.peerId,
        {
          kind: "offer",
          description: {
            type: link.pc.localDescription.type,
            sdp: link.pc.localDescription.sdp,
          },
        },
        { waitForPeerAck: true },
      );
    } catch (error) {
      this.events.emit("error", error as Error);
    } finally {
      link.makingOffer = false;
    }
  }

  private async handleSignalMessage(message: SignalMessage): Promise<void> {
    const link = this.ensurePeer(message.fromPeerId);
    this.events.emit("signal", { peerId: message.fromPeerId, payload: message.payload });

    switch (message.payload.kind) {
      case "offer":
      case "answer": {
        const description = message.payload.description as RTCSessionDescriptionInit | undefined;
        if (!description) {
          this.events.emit("error", new Error(`Signal missing description: ${message.payload.kind}`));
          return;
        }

        const readyForOffer =
          !link.makingOffer && (link.pc.signalingState === "stable" || link.isSettingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;

        link.ignoreOffer = !link.polite && offerCollision;
        if (link.ignoreOffer) {
          return;
        }

        link.isSettingRemoteAnswerPending = description.type === "answer";

        try {
          await link.pc.setRemoteDescription(description);
          await this.flushPendingRemoteCandidates(link);
        } finally {
          link.isSettingRemoteAnswerPending = false;
        }

        if (description.type === "offer") {
          await link.pc.setLocalDescription();
          if (!link.pc.localDescription) {
            return;
          }

          await this.signaling.sendSignal(
            message.fromPeerId,
            {
              kind: "answer",
              description: {
                type: link.pc.localDescription.type,
                sdp: link.pc.localDescription.sdp,
              },
            },
            { waitForPeerAck: true },
          );
        }
        return;
      }
      case "ice": {
        if (link.ignoreOffer) {
          return;
        }
        const candidate = (message.payload.candidate ?? null) as RTCIceCandidateInit | null;
        if (!link.pc.remoteDescription) {
          link.pendingRemoteCandidates.push(candidate);
          return;
        }
        try {
          await link.pc.addIceCandidate(candidate);
        } catch (error) {
          if (!link.ignoreOffer) {
            this.events.emit("error", error as Error);
          }
        }
        return;
      }
      case "renegotiate": {
        await this.negotiate(link);
        return;
      }
      case "bye": {
        this.closePeer(message.fromPeerId);
      }
    }
  }

  private closePeer(peerId: string): void {
    const link = this.peers.get(peerId);
    if (!link) {
      return;
    }

    link.pc.close();
    for (const channel of link.dataChannels.values()) {
      channel.close();
    }
    this.peers.delete(peerId);
  }

  private async flushPendingRemoteCandidates(link: PeerLink): Promise<void> {
    if (!link.pc.remoteDescription || link.pendingRemoteCandidates.length === 0) {
      return;
    }

    const pending = link.pendingRemoteCandidates.splice(0, link.pendingRemoteCandidates.length);
    for (const candidate of pending) {
      try {
        await link.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!link.ignoreOffer) {
          this.events.emit("error", error as Error);
        }
      }
    }
  }

  private shouldInitiate(remotePeerId: string): boolean {
    if (!this.signaling.peerId) {
      return false;
    }
    return this.signaling.peerId < remotePeerId;
  }

  private isPolite(remotePeerId: string): boolean {
    if (!this.signaling.peerId) {
      return false;
    }
    return this.signaling.peerId > remotePeerId;
  }

  private sendOnChannel(channel: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === "string") {
      channel.send(data);
      return;
    }
    if (data instanceof Blob) {
      channel.send(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      channel.send(data);
      return;
    }
    channel.send(data as ArrayBufferView<ArrayBuffer>);
  }
}

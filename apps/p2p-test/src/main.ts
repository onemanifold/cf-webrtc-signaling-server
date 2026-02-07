import { SignalingClient, WebRTCMeshClient, type PeerSummary } from "@cf-webrtc/client";

type Nullable<T> = T | null;

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const workerBaseUrlInput = getElement<HTMLInputElement>("#workerBaseUrl");
const roomIdInput = getElement<HTMLInputElement>("#roomId");
const userIdInput = getElement<HTMLInputElement>("#userId");
const aliasInput = getElement<HTMLInputElement>("#alias");
const joinTokenInput = getElement<HTMLInputElement>("#joinToken");
const internalSecretInput = getElement<HTMLInputElement>("#internalSecret");
const resolveAliasInput = getElement<HTMLInputElement>("#resolveAliasInput");
const chatInput = getElement<HTMLInputElement>("#chatInput");
const shareLinkInput = getElement<HTMLInputElement>("#shareLink");

const issueTokenBtn = getElement<HTMLButtonElement>("#issueTokenBtn");
const connectBtn = getElement<HTMLButtonElement>("#connectBtn");
const disconnectBtn = getElement<HTMLButtonElement>("#disconnectBtn");
const startMediaBtn = getElement<HTMLButtonElement>("#startMediaBtn");
const copyShareLinkBtn = getElement<HTMLButtonElement>("#copyShareLinkBtn");
const resolveAliasBtn = getElement<HTMLButtonElement>("#resolveAliasBtn");
const claimAliasBtn = getElement<HTMLButtonElement>("#claimAliasBtn");
const sendChatBtn = getElement<HTMLButtonElement>("#sendChatBtn");

const resolveResult = getElement<HTMLPreElement>("#resolveResult");
const eventLog = getElement<HTMLPreElement>("#eventLog");
const chatLog = getElement<HTMLPreElement>("#chatLog");
const peerList = getElement<HTMLUListElement>("#peerList");
const localVideo = getElement<HTMLVideoElement>("#localVideo");
const remoteVideos = getElement<HTMLDivElement>("#remoteVideos");

const envDefaultWorker = import.meta.env.VITE_DEFAULT_WORKER_URL?.trim();
const query = new URLSearchParams(window.location.search);
const generatedId = crypto.randomUUID().slice(0, 8);
const defaultWorker =
  query.get("worker")?.trim() || envDefaultWorker || "https://your-worker.workers.dev";
const defaultRoom = query.get("room")?.trim() || roomIdInput.value || "main-room";
const defaultUserId = query.get("userId")?.trim() || `user-${generatedId}`;
const defaultAlias = query.get("alias")?.trim() || `peer-${generatedId.slice(0, 4)}`;
const defaultJoinToken = query.get("token")?.trim() || "";
const defaultInternalSecret = query.get("internalSecret")?.trim() || "";
const shouldAutoConnect = ["1", "true", "yes"].includes(
  (query.get("autoconnect")?.trim().toLowerCase() ?? ""),
);
workerBaseUrlInput.value = defaultWorker;
roomIdInput.value = defaultRoom;
userIdInput.value = defaultUserId;
aliasInput.value = defaultAlias;
if (defaultJoinToken) {
  joinTokenInput.value = defaultJoinToken;
}
if (defaultInternalSecret) {
  internalSecretInput.value = defaultInternalSecret;
}

let signaling: Nullable<SignalingClient> = null;
let mesh: Nullable<WebRTCMeshClient> = null;
let localStream: Nullable<MediaStream> = null;
let isConnecting = false;
let wsDialAttempt = 0;
let tokenRefreshCount = 0;
const peers = new Map<string, PeerSummary>();
const remoteStreamByPeer = new Map<string, MediaStream>();

function appendLog(element: HTMLPreElement, message: string): void {
  const next = `${new Date().toISOString()} ${message}`;
  element.textContent = `${next}\n${element.textContent ?? ""}`.slice(0, 12_000);
}

function tokenFingerprint(token: string): string {
  if (!token) {
    return "none";
  }
  if (token.length <= 18) {
    return token;
  }
  return `${token.slice(0, 12)}...${token.slice(-6)}`;
}

interface DecodedJoinTokenPayload {
  sub?: string;
  room?: string;
  name?: string;
  exp?: number;
  iat?: number;
}

function decodeJoinTokenPayload(token: string): DecodedJoinTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payloadBase64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadBase64.padEnd(Math.ceil(payloadBase64.length / 4) * 4, "=");
    const decoded = atob(padded);
    const json = JSON.parse(decoded) as DecodedJoinTokenPayload;
    return json;
  } catch {
    return null;
  }
}

function tokenRemainingSeconds(token: string): number | null {
  const payload = decodeJoinTokenPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return payload.exp - now;
}

async function ensureJoinToken(options: {
  forceRefresh?: boolean;
  minRemainingSec?: number;
  reason: string;
}): Promise<string> {
  const forceRefresh = options.forceRefresh ?? false;
  const minRemainingSec = options.minRemainingSec ?? 45;

  let token = joinTokenInput.value.trim();
  let mustIssue = forceRefresh || !token;
  const remaining = token ? tokenRemainingSeconds(token) : null;

  if (!mustIssue && remaining !== null && remaining <= minRemainingSec) {
    mustIssue = true;
  }

  if (!mustIssue && token && remaining === null) {
    appendLog(eventLog, `Join token check reason=${options.reason} result=keep-unparsable token=${tokenFingerprint(token)}`);
    return token;
  }

  if (!mustIssue && token && remaining !== null) {
    appendLog(
      eventLog,
      `Join token check reason=${options.reason} result=reuse remaining=${remaining}s token=${tokenFingerprint(token)}`,
    );
    return token;
  }

  token = await issueTokenValue();
  joinTokenInput.value = token;
  tokenRefreshCount += 1;
  const nextRemaining = tokenRemainingSeconds(token);
  appendLog(
    eventLog,
    `Join token refresh #${tokenRefreshCount} reason=${options.reason} remaining=${nextRemaining ?? "unknown"}s token=${tokenFingerprint(token)}`,
  );
  return token;
}

function redactWsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token");
    if (token) {
      parsed.searchParams.set("token", tokenFingerprint(token));
    }
    const resumeToken = parsed.searchParams.get("resumeToken");
    if (resumeToken) {
      parsed.searchParams.set("resumeToken", tokenFingerprint(resumeToken));
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function toHttpBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

function toWsBase(base: string): string {
  const http = toHttpBase(base);
  if (http.startsWith("wss://") || http.startsWith("ws://")) {
    return `${http}/ws`.replace(/\/ws\/ws$/, "/ws");
  }
  if (http.startsWith("https://")) {
    return `${http.replace("https://", "wss://")}/ws`;
  }
  if (http.startsWith("http://")) {
    return `${http.replace("http://", "ws://")}/ws`;
  }
  throw new Error("Worker Base URL must start with http(s):// or ws(s)://");
}

async function probeWsHttpPath(httpBaseUrl: string, roomId: string, token: string): Promise<void> {
  const trace = `http-probe-${crypto.randomUUID().slice(0, 8)}`;
  const probeUrl = `${httpBaseUrl}/ws/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}&trace=${trace}`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(probeUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 180).replace(/\s+/g, " ").trim();
    appendLog(
      eventLog,
      `WS HTTP probe trace=${trace} status=${response.status} elapsed=${Date.now() - startedAt}ms body=${body || "<empty>"}`,
    );
  } catch (error) {
    appendLog(
      eventLog,
      `WS HTTP probe trace=${trace} failed elapsed=${Date.now() - startedAt}ms error=${(error as Error).message}`,
    );
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function probeWsReachability(wsBaseUrl: string, roomId: string): Promise<void> {
  const trace = `ws-probe-${crypto.randomUUID().slice(0, 8)}`;
  const probeUrl = `${wsBaseUrl}/${encodeURIComponent(roomId)}?token=x&trace=${trace}`;
  const startedAt = Date.now();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (message: string) => {
      if (done) {
        return;
      }
      done = true;
      appendLog(eventLog, message);
      resolve();
    };

    const socket = new WebSocket(probeUrl);
    const timeoutId = window.setTimeout(() => {
      finish(`WS reachability probe trace=${trace} timeout elapsed=${Date.now() - startedAt}ms`);
      try {
        socket.close(1000, "probe-timeout");
      } catch {
        // no-op
      }
    }, 8_000);

    const clear = () => window.clearTimeout(timeoutId);
    socket.addEventListener("open", () => {
      clear();
      finish(`WS reachability probe trace=${trace} open elapsed=${Date.now() - startedAt}ms`);
      try {
        socket.close(1000, "probe-done");
      } catch {
        // no-op
      }
    });
    socket.addEventListener("close", (event) => {
      clear();
      finish(
        `WS reachability probe trace=${trace} close elapsed=${Date.now() - startedAt}ms code=${event.code} reason=${event.reason}`,
      );
    });
    socket.addEventListener("error", () => {
      appendLog(eventLog, `WS reachability probe trace=${trace} error elapsed=${Date.now() - startedAt}ms`);
    });
  });
}

function setConnectedUiState(connected: boolean): void {
  connectBtn.disabled = connected || isConnecting;
  disconnectBtn.disabled = !connected;
  resolveAliasBtn.disabled = !connected;
  claimAliasBtn.disabled = !connected;
  sendChatBtn.disabled = !connected;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function makeShareLink(): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";

  const worker = workerBaseUrlInput.value.trim();
  const room = roomIdInput.value.trim();

  const params = new URLSearchParams();
  if (worker) {
    params.set("worker", worker);
  }
  if (room) {
    params.set("room", room);
  }

  url.search = params.toString();
  return url.toString();
}

function refreshShareLink(): void {
  shareLinkInput.value = makeShareLink();
}

function renderPeers(): void {
  peerList.innerHTML = "";
  for (const peer of peers.values()) {
    const li = document.createElement("li");
    li.textContent = `${peer.peerId} (${peer.name ?? "no-alias"})`;
    peerList.appendChild(li);
  }
}

function getOrCreateRemoteCard(peerId: string): HTMLVideoElement {
  let video = remoteVideos.querySelector<HTMLVideoElement>(`video[data-peer-id='${peerId}']`);
  if (video) {
    return video;
  }

  const card = document.createElement("div");
  card.className = "video-card";

  const title = document.createElement("h3");
  title.textContent = `Remote ${peerId}`;

  video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("data-peer-id", peerId);

  card.appendChild(title);
  card.appendChild(video);
  remoteVideos.appendChild(card);
  return video;
}

function removeRemoteCard(peerId: string): void {
  const video = remoteVideos.querySelector<HTMLVideoElement>(`video[data-peer-id='${peerId}']`);
  if (!video) {
    return;
  }
  video.parentElement?.remove();
  remoteStreamByPeer.delete(peerId);
}

async function issueTokenValue(): Promise<string> {
  const baseUrl = toHttpBase(workerBaseUrlInput.value);
  const roomId = roomIdInput.value.trim();
  const userId = userIdInput.value.trim();
  const alias = aliasInput.value.trim();
  const internalSecret = internalSecretInput.value.trim();

  if (!baseUrl || !roomId || !userId) {
    throw new Error("worker base URL, room ID, and user ID are required");
  }

  const headers: Record<string, string> = {
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
      roomId,
      userId,
      name: alias || undefined,
      ttlSeconds: 180,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token issue failed (${response.status}): ${body}`);
  }

  const body = (await response.json()) as { token: string };
  return body.token;
}

async function issueToken(): Promise<void> {
  await ensureJoinToken({
    forceRefresh: true,
    reason: "manual-issue-button",
  });
  appendLog(eventLog, "Issued join token successfully.");
}

function bindSignalingEvents(client: SignalingClient): void {
  client.on("connected", (message) => {
    appendLog(eventLog, `Connected as ${message.peerId}`);
    peers.clear();
    for (const peer of message.peers) {
      peers.set(peer.peerId, peer);
    }
    renderPeers();
    setConnectedUiState(true);
  });

  client.on("reconnected", (message) => {
    appendLog(eventLog, `Reconnected as ${message.peerId}`);
    peers.clear();
    for (const peer of message.peers) {
      peers.set(peer.peerId, peer);
    }
    renderPeers();
    setConnectedUiState(true);
  });

  client.on("presenceJoined", (peer) => {
    peers.set(peer.peerId, peer);
    renderPeers();
    appendLog(eventLog, `Peer joined: ${peer.peerId} (${peer.name ?? "no alias"})`);
  });

  client.on("presenceLeft", ({ peerId }) => {
    peers.delete(peerId);
    renderPeers();
    removeRemoteCard(peerId);
    appendLog(eventLog, `Peer left: ${peerId}`);
  });

  client.on("aliasClaimed", ({ name, userId }) => {
    appendLog(eventLog, `Alias claimed: ${name} by ${userId}`);
  });

  client.on("aliasResolved", ({ name, peers: foundPeers }) => {
    resolveResult.textContent = JSON.stringify({ name, peers: foundPeers }, null, 2);
  });

  client.on("error", (error) => {
    appendLog(eventLog, `ERROR: ${error.message}`);
  });

  client.on("disconnected", ({ code, reason }) => {
    appendLog(eventLog, `Disconnected: code=${code} reason=${reason}`);
    setConnectedUiState(false);
  });
}

function bindMeshEvents(instance: WebRTCMeshClient): void {
  instance.on("peerConnected", ({ peerId, state }) => {
    appendLog(eventLog, `P2P connected: ${peerId} (${state})`);
  });

  instance.on("peerDisconnected", ({ peerId, state }) => {
    appendLog(eventLog, `P2P disconnected: ${peerId} (${state})`);
    removeRemoteCard(peerId);
  });

  instance.on("track", ({ peerId, event }) => {
    const stream = event.streams[0];
    if (!stream) {
      return;
    }
    remoteStreamByPeer.set(peerId, stream);
    const video = getOrCreateRemoteCard(peerId);
    video.srcObject = stream;
    appendLog(eventLog, `Remote track from ${peerId}`);
  });

  instance.on("dataChannel", ({ peerId, channel }) => {
    appendLog(eventLog, `Data channel opened for ${peerId}: ${channel.label}`);
    channel.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : "[binary]";
      appendLog(chatLog, `${peerId}: ${text}`);
    };
  });

  instance.on("error", (error) => {
    appendLog(eventLog, `MESH ERROR: ${error.message}`);
  });
}

async function connect(): Promise<void> {
  if (isConnecting) {
    throw new Error("Connection already in progress");
  }
  if (signaling || mesh) {
    throw new Error("Already connected");
  }
  isConnecting = true;
  setConnectedUiState(false);

  try {
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      throw new Error("Room ID is required");
    }
    let token = await ensureJoinToken({
      reason: "connect-start",
      minRemainingSec: 60,
    });
    if (!token) {
      throw new Error("Join token is required. Paste a token or click Issue Token.");
    }
    appendLog(
      eventLog,
      `Connect start room=${roomId} userId=${userIdInput.value.trim()} alias=${aliasInput.value.trim() || "none"} token=${tokenFingerprint(token)}`,
    );

    const wsBaseUrl = toWsBase(workerBaseUrlInput.value);
    const httpBaseUrl = toHttpBase(workerBaseUrlInput.value);
    appendLog(eventLog, `Transport config wsBaseUrl=${wsBaseUrl} httpBaseUrl=${httpBaseUrl}`);
    await probeWsHttpPath(httpBaseUrl, roomId, token);
    await probeWsReachability(wsBaseUrl, roomId);

    const client = new SignalingClient({
      wsBaseUrl,
      httpBaseUrl,
      roomId,
      alias: aliasInput.value.trim() || undefined,
      getJoinToken: async () =>
        ensureJoinToken({
          reason: "ws-open",
          minRemainingSec: 45,
        }),
      handshakeTimeoutMs: 20_000,
      webSocketFactory: (url) => {
        wsDialAttempt += 1;
        const attempt = wsDialAttempt;
        const startedAt = Date.now();
        const trace = `a${attempt}-${crypto.randomUUID().slice(0, 8)}`;
        const tracedUrl = new URL(url);
        tracedUrl.searchParams.set("trace", trace);
        appendLog(eventLog, `WS dialing attempt=${attempt} trace=${trace} ${redactWsUrl(tracedUrl.toString())}`);
        const socket = new WebSocket(tracedUrl.toString());
        const probe = window.setTimeout(() => {
          appendLog(
            eventLog,
            `WS still connecting attempt=${attempt} trace=${trace} elapsed=${Date.now() - startedAt}ms`,
          );
        }, 5_000);
        const clearProbe = () => window.clearTimeout(probe);
        socket.addEventListener("open", () => {
          clearProbe();
          appendLog(eventLog, `WS transport open attempt=${attempt} trace=${trace} elapsed=${Date.now() - startedAt}ms`);
        });
        socket.addEventListener("close", (event) => {
          clearProbe();
          appendLog(
            eventLog,
            `WS transport close attempt=${attempt} trace=${trace} elapsed=${Date.now() - startedAt}ms code=${event.code} reason=${event.reason}`,
          );
        });
        socket.addEventListener("error", () => {
          appendLog(eventLog, `WS transport error attempt=${attempt} trace=${trace} elapsed=${Date.now() - startedAt}ms`);
        });
        return socket;
      },
    });

    bindSignalingEvents(client);

    let rtcConfiguration: RTCConfiguration | undefined;
    try {
      let turn = await client.fetchTurnCredentials();
      if (!turn?.iceServers) {
        throw new Error("ICE credentials response missing iceServers");
      }
      rtcConfiguration = {
        iceServers: turn.iceServers as unknown as RTCIceServer[],
      };
      appendLog(eventLog, `Fetched ICE servers (${turn.iceServers.length}).`);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (message.includes("(401)")) {
        appendLog(eventLog, "Join token rejected (401); issuing a fresh token and retrying once.");
        token = await ensureJoinToken({
          forceRefresh: true,
          reason: "turn-401-retry",
          minRemainingSec: 60,
        });
        try {
          const turn = await client.fetchTurnCredentials();
          rtcConfiguration = {
            iceServers: turn.iceServers as unknown as RTCIceServer[],
          };
          appendLog(eventLog, `Fetched ICE servers after token refresh (${turn.iceServers.length}).`);
        } catch (retryError) {
          appendLog(
            eventLog,
            `ICE credentials fetch still failing after token refresh: ${(retryError as Error).message}`,
          );
        }
      } else {
        appendLog(eventLog, `ICE credentials fetch skipped/failing: ${message}`);
      }
    }

    const meshClient = new WebRTCMeshClient({
      signaling: client,
      rtcConfiguration,
      autoCreateDataChannel: true,
      dataChannelLabel: "p2p-chat",
    });

    bindMeshEvents(meshClient);

    try {
      await withTimeout(meshClient.start(), 30_000, "Signaling connection");
      appendLog(eventLog, "Signaling session established.");
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (message.includes("before session established (1006)")) {
        appendLog(eventLog, "WebSocket failed before session established. Clearing stale token; click Connect again.");
        joinTokenInput.value = "";
      }
      meshClient.stop();
      throw error;
    }

    if (localStream) {
      for (const track of localStream.getTracks()) {
        meshClient.addTrack(track, localStream);
      }
    }

    signaling = client;
    mesh = meshClient;
    setConnectedUiState(true);
  } finally {
    isConnecting = false;
    setConnectedUiState(Boolean(signaling && mesh));
  }
}

function disconnect(): void {
  mesh?.stop();
  mesh = null;
  signaling = null;
  peers.clear();
  renderPeers();
  setConnectedUiState(false);
  appendLog(eventLog, "Disconnected by user.");
}

async function startMedia(): Promise<void> {
  if (localStream) {
    appendLog(eventLog, "Local media already active.");
    return;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });

  localVideo.srcObject = localStream;
  appendLog(eventLog, "Local media started.");

  if (mesh) {
    for (const track of localStream.getTracks()) {
      mesh.addTrack(track, localStream);
    }
  }
}

async function resolveAlias(): Promise<void> {
  if (!signaling) {
    throw new Error("Not connected");
  }
  const alias = resolveAliasInput.value.trim();
  if (!alias) {
    throw new Error("Enter an alias to resolve");
  }
  const found = await signaling.resolveAlias(alias);
  resolveResult.textContent = JSON.stringify(found, null, 2);
}

async function claimAlias(): Promise<void> {
  if (!signaling) {
    throw new Error("Not connected");
  }
  const alias = aliasInput.value.trim();
  if (!alias) {
    throw new Error("Enter alias in Alias field first");
  }
  await signaling.claimAlias(alias);
}

function sendChat(): void {
  if (!mesh) {
    throw new Error("Not connected");
  }
  const message = chatInput.value.trim();
  if (!message) {
    return;
  }
  mesh.broadcastData(message);
  appendLog(chatLog, `me: ${message}`);
  chatInput.value = "";
}

function bindButton(button: HTMLButtonElement, handler: () => Promise<void> | void): void {
  button.addEventListener("click", () => {
    Promise.resolve(handler()).catch((error) => {
      appendLog(eventLog, `ERROR: ${(error as Error).message}`);
    });
  });
}

setConnectedUiState(false);
bindButton(issueTokenBtn, issueToken);
bindButton(connectBtn, connect);
bindButton(disconnectBtn, () => disconnect());
bindButton(startMediaBtn, startMedia);
bindButton(copyShareLinkBtn, async () => {
  refreshShareLink();
  const text = shareLinkInput.value;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    shareLinkInput.select();
    document.execCommand("copy");
  }
  appendLog(eventLog, "Share link copied to clipboard.");
});
bindButton(resolveAliasBtn, resolveAlias);
bindButton(claimAliasBtn, claimAlias);
bindButton(sendChatBtn, () => sendChat());

workerBaseUrlInput.addEventListener("input", refreshShareLink);
roomIdInput.addEventListener("input", refreshShareLink);
refreshShareLink();

appendLog(eventLog, "App ready.");
appendLog(
  eventLog,
  `Runtime ua=${navigator.userAgent} online=${navigator.onLine} origin=${window.location.origin}`,
);

if (shouldAutoConnect) {
  appendLog(eventLog, "Auto-connect requested by URL.");
  Promise.resolve(connect()).catch((error) => {
    appendLog(eventLog, `ERROR: ${(error as Error).message}`);
  });
}

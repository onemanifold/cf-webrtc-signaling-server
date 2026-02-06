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
const defaultWorker =
  query.get("worker")?.trim() || envDefaultWorker || "https://your-worker.workers.dev";
const defaultRoom = query.get("room")?.trim() || roomIdInput.value || "main-room";
workerBaseUrlInput.value = defaultWorker;
roomIdInput.value = defaultRoom;

let signaling: Nullable<SignalingClient> = null;
let mesh: Nullable<WebRTCMeshClient> = null;
let localStream: Nullable<MediaStream> = null;
const peers = new Map<string, PeerSummary>();
const remoteStreamByPeer = new Map<string, MediaStream>();

function appendLog(element: HTMLPreElement, message: string): void {
  const next = `${new Date().toISOString()} ${message}`;
  element.textContent = `${next}\n${element.textContent ?? ""}`.slice(0, 12_000);
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

function setConnectedUiState(connected: boolean): void {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  resolveAliasBtn.disabled = !connected;
  claimAliasBtn.disabled = !connected;
  sendChatBtn.disabled = !connected;
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

async function issueToken(): Promise<void> {
  const baseUrl = toHttpBase(workerBaseUrlInput.value);
  const roomId = roomIdInput.value.trim();
  const userId = userIdInput.value.trim();
  const alias = aliasInput.value.trim();
  const internalSecret = internalSecretInput.value.trim();

  if (!baseUrl || !roomId || !userId || !internalSecret) {
    throw new Error("worker base URL, room ID, user ID, and internal secret are required");
  }

  const response = await fetch(`${baseUrl}/token/issue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": internalSecret,
    },
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
  joinTokenInput.value = body.token;
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
  if (signaling || mesh) {
    throw new Error("Already connected");
  }

  const roomId = roomIdInput.value.trim();
  const token = joinTokenInput.value.trim();
  if (!roomId) {
    throw new Error("Room ID is required");
  }
  if (!token) {
    throw new Error("Join token is required. Use Issue Token or paste one.");
  }

  const wsBaseUrl = toWsBase(workerBaseUrlInput.value);
  const httpBaseUrl = toHttpBase(workerBaseUrlInput.value);

  const client = new SignalingClient({
    wsBaseUrl,
    httpBaseUrl,
    roomId,
    alias: aliasInput.value.trim() || undefined,
    getJoinToken: async () => joinTokenInput.value.trim(),
  });

  bindSignalingEvents(client);

  let rtcConfiguration: RTCConfiguration | undefined;
  try {
    const turn = await client.fetchTurnCredentials();
    rtcConfiguration = {
      iceServers: turn.iceServers as unknown as RTCIceServer[],
    };
    appendLog(eventLog, `Fetched ICE servers (${turn.iceServers.length}).`);
  } catch (error) {
    appendLog(eventLog, `TURN fetch skipped/failing: ${(error as Error).message}`);
  }

  const meshClient = new WebRTCMeshClient({
    signaling: client,
    rtcConfiguration,
    autoCreateDataChannel: true,
    dataChannelLabel: "p2p-chat",
  });

  bindMeshEvents(meshClient);

  await meshClient.start();

  if (localStream) {
    for (const track of localStream.getTracks()) {
      meshClient.addTrack(track, localStream);
    }
  }

  signaling = client;
  mesh = meshClient;
  setConnectedUiState(true);
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

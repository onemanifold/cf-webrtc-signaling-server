import { fromBase64Url, hmacSha1Base64 } from "./crypto-utils";
import { signJoinToken, parseBearerToken, verifyJoinToken } from "./join-token";
import { RateLimitDO } from "./do/rate-limit-do";
import { SignalingRoomDO } from "./do/signaling-room-do";
import type { Env, ExecutionContextLike } from "./types";

interface TurnCredentials {
  username: string;
  credential: string;
  ttlSeconds: number;
}

interface RateLimitResponse {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface DevIssueTokenRequest {
  userId: string;
  roomId: string;
  name?: string;
  ttlSeconds?: number;
}

interface WsDebugEvent {
  ts: number;
  phase: string;
  roomId: string | null;
  trace: string | null;
  ua: string;
  origin: string;
  upgrade: string;
  hasWsKey: boolean;
  hasWsVersion: boolean;
  cfRay: string;
  httpProtocol: string;
  detail?: string;
  status?: number;
  hasWebSocket?: boolean;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-internal-secret,x-dev-issuer-secret",
};

const WS_DEBUG_MAX = 240;
const wsDebugEvents: WsDebugEvent[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function jsonError(code: string, message: string, status = 400): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
      },
    },
    status,
  );
}

function toBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function parseTokenFromRequest(request: Request, url: URL): string | null {
  const bearer = parseBearerToken(request.headers.get("Authorization"));
  if (bearer) {
    return bearer;
  }
  return url.searchParams.get("token");
}

function parseTokenExpUnsafe(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function extractRoomIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function isWebSocketHandshakeRequest(request: Request): boolean {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return true;
  }

  // Some clients/proxies may not expose Upgrade cleanly; accept standard WS hint headers too.
  return (
    request.headers.has("sec-websocket-key") ||
    request.headers.has("Sec-WebSocket-Key") ||
    request.headers.has("sec-websocket-version") ||
    request.headers.has("Sec-WebSocket-Version")
  );
}

function parseCommaList(input: string | undefined): string[] {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getHttpProtocol(request: Request): string {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
  const value = cf && typeof cf.httpProtocol === "string" ? cf.httpProtocol : "";
  return value || "unknown";
}

function pushWsDebug(event: Omit<WsDebugEvent, "ts">): WsDebugEvent {
  const fullEvent: WsDebugEvent = {
    ts: Date.now(),
    ...event,
  };
  wsDebugEvents.push(fullEvent);
  if (wsDebugEvents.length > WS_DEBUG_MAX) {
    wsDebugEvents.splice(0, wsDebugEvents.length - WS_DEBUG_MAX);
  }
  return fullEvent;
}

async function appendRoomWsDebug(env: Env, event: WsDebugEvent): Promise<void> {
  if (!event.roomId) {
    return;
  }
  if (!env.INTERNAL_API_SECRET) {
    return;
  }
  const roomStub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(event.roomId));
  await roomStub.fetch("https://room.internal/__internal/debug/edge-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.INTERNAL_API_SECRET,
    },
    body: JSON.stringify(event),
  });
}

function recordWsDebug(env: Env, ctx: ExecutionContextLike, event: Omit<WsDebugEvent, "ts">): void {
  const fullEvent = pushWsDebug(event);
  ctx.waitUntil(
    appendRoomWsDebug(env, fullEvent).catch(() => {
      // best-effort debug path
    }),
  );
}

async function readRoomWsDebug(env: Env, roomId: string, limit: number): Promise<WsDebugEvent[] | null> {
  if (!env.INTERNAL_API_SECRET) {
    return null;
  }
  const roomStub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(roomId));
  const response = await roomStub.fetch(
    `https://room.internal/__internal/debug/edge-recent?limit=${encodeURIComponent(String(limit))}`,
    {
      method: "GET",
      headers: {
        "x-internal-secret": env.INTERNAL_API_SECRET,
      },
    },
  );
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as { events?: WsDebugEvent[] };
  if (!Array.isArray(payload.events)) {
    return null;
  }
  return payload.events;
}

function isDebugAuthorized(request: Request, env: Env): boolean {
  const provided =
    request.headers.get("x-dev-issuer-secret") ??
    request.headers.get("x-internal-secret") ??
    new URL(request.url).searchParams.get("secret");
  if (!provided) {
    return false;
  }
  const valid = [env.DEV_ISSUER_SECRET, env.INTERNAL_API_SECRET].filter(
    (candidate): candidate is string => Boolean(candidate && candidate.length > 0),
  );
  return valid.includes(provided);
}

async function checkTurnRateLimit(env: Env, userId: string): Promise<RateLimitResponse> {
  const max = Math.max(1, Math.floor(toNumber(env.TURN_RATE_LIMIT_MAX, 10)));
  const windowSec = Math.max(1, Math.floor(toNumber(env.TURN_RATE_LIMIT_WINDOW_SEC, 60)));
  const id = env.RATE_LIMIT_DO.idFromName(`turn:${userId}`);
  const stub = env.RATE_LIMIT_DO.get(id);
  const response = await stub.fetch("https://rate-limit.local", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      key: "turn",
      max,
      windowSec,
    }),
  });
  if (!response.ok) {
    throw new Error(`Rate limiter error (${response.status})`);
  }
  return (await response.json()) as RateLimitResponse;
}

async function makeTurnCredentials(env: Env, userId: string): Promise<TurnCredentials | null> {
  const turnSecret = env.TURN_SHARED_SECRET;
  if (!turnSecret) {
    return null;
  }

  const ttlSeconds = Math.max(60, Math.floor(toNumber(env.TURN_TTL_SECONDS, 3600)));
  const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = await hmacSha1Base64(turnSecret, username);

  return {
    username,
    credential,
    ttlSeconds,
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(k)) {
      headers.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const executionContext = ctx ?? {
      waitUntil() {
        // no-op fallback for tests
      },
    };
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: JSON_HEADERS,
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, now: Date.now() });
    }

    if (url.pathname === "/debug/ws-recent" && request.method === "GET") {
      if (!toBoolean(env.ALLOW_DEV_TOKEN_ISSUER, false)) {
        return jsonError("DEV_ISSUER_DISABLED", "Debug endpoint disabled", 403);
      }
      if (!isDebugAuthorized(request, env)) {
        return jsonError("FORBIDDEN", "Missing or invalid debug secret", 403);
      }
      const roomFilter = url.searchParams.get("roomId");
      const limitRaw = Number(url.searchParams.get("limit") ?? "80");
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 80;
      if (roomFilter) {
        const roomEvents = await readRoomWsDebug(env, roomFilter, limit).catch(() => null);
        if (roomEvents) {
          return jsonResponse({
            count: roomEvents.length,
            roomId: roomFilter,
            source: "room-do",
            events: roomEvents,
          });
        }
      }
      const filtered = roomFilter ? wsDebugEvents.filter((event) => event.roomId === roomFilter) : wsDebugEvents;
      const events = filtered.slice(-limit);
      return jsonResponse({
        count: events.length,
        roomId: roomFilter ?? null,
        source: "edge-isolate",
        events,
      });
    }

    if (url.pathname === "/token/issue" && request.method === "POST") {
      if (!toBoolean(env.ALLOW_DEV_TOKEN_ISSUER, false)) {
        return jsonError("DEV_ISSUER_DISABLED", "Token issuer is disabled", 403);
      }

      const providedSecret =
        request.headers.get("x-dev-issuer-secret") ?? request.headers.get("x-internal-secret");
      if (providedSecret) {
        const validSecrets = [env.DEV_ISSUER_SECRET, env.INTERNAL_API_SECRET].filter(
          (candidate): candidate is string => Boolean(candidate && candidate.length > 0),
        );
        if (!validSecrets.includes(providedSecret)) {
          return jsonError("FORBIDDEN", "Invalid issuer secret", 403);
        }
      }

      const body = (await request.json().catch(() => null)) as DevIssueTokenRequest | null;
      if (!body || typeof body.userId !== "string" || typeof body.roomId !== "string") {
        return jsonError("BAD_REQUEST", "Expected userId and roomId", 400);
      }

      const ttlSeconds = Math.max(30, Math.min(600, Math.floor(body.ttlSeconds ?? 120)));
      const now = Math.floor(Date.now() / 1_000);
      const token = await signJoinToken(
        {
          sub: body.userId,
          room: body.roomId,
          name: body.name,
          iat: now,
          exp: now + ttlSeconds,
          jti: crypto.randomUUID(),
        },
        env.JOIN_TOKEN_SECRET,
      );

      return jsonResponse({
        token,
        roomId: body.roomId,
        userId: body.userId,
        name: body.name ?? null,
        expiresAt: (now + ttlSeconds) * 1_000,
      });
    }

    if (url.pathname === "/turn-credentials" && request.method === "GET") {
      const token = parseTokenFromRequest(request, url);
      if (!token) {
        return jsonError("UNAUTHORIZED", "Missing bearer token", 401);
      }

      let payload;
      try {
        payload = await verifyJoinToken(token, env.JOIN_TOKEN_SECRET);
      } catch (error) {
        return jsonError("UNAUTHORIZED", String((error as Error).message), 401);
      }

      let rateLimit: RateLimitResponse;
      try {
        rateLimit = await checkTurnRateLimit(env, payload.sub);
      } catch {
        return jsonError("RATE_LIMIT_ERROR", "TURN limiter unavailable", 503);
      }

      if (!rateLimit.allowed) {
        return jsonResponse(
          {
            error: {
              code: "RATE_LIMITED",
              message: "TURN credential rate limit exceeded",
            },
            rateLimit,
          },
          429,
        );
      }

      const turnUrls = parseCommaList(env.TURN_URLS);
      const turnCreds = await makeTurnCredentials(env, payload.sub);

      const iceServers: Array<Record<string, unknown>> = [
        {
          urls: ["stun:stun.l.google.com:19302"],
        },
      ];

      if (turnCreds && turnUrls.length > 0) {
        iceServers.push({
          urls: turnUrls,
          username: turnCreds.username,
          credential: turnCreds.credential,
        });
      }

      return jsonResponse({
        iceServers,
        ttlSeconds: turnCreds?.ttlSeconds ?? 0,
        rateLimit,
      });
    }

    const roomId = extractRoomIdFromPath(url.pathname);
    const trace = url.searchParams.get("trace") || url.searchParams.get("clientTrace") || null;
    const wsMeta = {
      roomId,
      trace,
      ua: request.headers.get("user-agent") ?? "",
      origin: request.headers.get("origin") ?? "",
      upgrade: request.headers.get("upgrade") ?? "",
      hasWsKey: request.headers.has("sec-websocket-key") || request.headers.has("Sec-WebSocket-Key"),
      hasWsVersion: request.headers.has("sec-websocket-version") || request.headers.has("Sec-WebSocket-Version"),
      cfRay: request.headers.get("cf-ray") ?? "",
      httpProtocol: getHttpProtocol(request),
    };

    if (roomId && !isWebSocketHandshakeRequest(request)) {
      recordWsDebug(env, executionContext, {
        ...wsMeta,
        phase: "edge_non_ws_room_route",
        detail: "room route requested without websocket handshake headers",
      });
      return jsonError("EXPECTED_WEBSOCKET", "Expected websocket upgrade", 426);
    }

    if (roomId && isWebSocketHandshakeRequest(request)) {
      recordWsDebug(env, executionContext, {
        ...wsMeta,
        phase: "edge_ws_request",
      });

      const token = parseTokenFromRequest(request, url);
      if (!token) {
        recordWsDebug(env, executionContext, {
          ...wsMeta,
          phase: "edge_ws_reject_missing_token",
        });
        return jsonError("UNAUTHORIZED", "Missing token for websocket", 401);
      }

      let payload;
      try {
        payload = await verifyJoinToken(token, env.JOIN_TOKEN_SECRET, { expectedRoom: roomId });
      } catch (error) {
        const now = Math.floor(Date.now() / 1_000);
        const exp = parseTokenExpUnsafe(token);
        const message = String((error as Error).message);
        const detail =
          message === "Token expired"
            ? `${message} now=${now} exp=${exp ?? "unknown"} skew=${exp !== null ? now - exp : "unknown"}`
            : message;
        recordWsDebug(env, executionContext, {
          ...wsMeta,
          phase: "edge_ws_reject_bad_token",
          detail,
        });
        return jsonError("UNAUTHORIZED", message, 401);
      }

      const roomStub = env.SIGNALING_ROOM.get(env.SIGNALING_ROOM.idFromName(roomId));
      const headers = new Headers(request.headers);
      headers.set("x-auth-user-id", payload.sub);
      headers.set("x-auth-room-id", payload.room);
      if (payload.name) {
        headers.set("x-auth-name", payload.name);
      }

      const doRequest = new Request(request.url, {
        method: request.method,
        headers,
      });

      recordWsDebug(env, executionContext, {
        ...wsMeta,
        phase: "edge_ws_forward_to_do",
      });
      const response = await roomStub.fetch(doRequest);
      recordWsDebug(env, executionContext, {
        ...wsMeta,
        phase: "edge_ws_response_from_do",
        status: response.status,
        hasWebSocket: Boolean(response.webSocket),
      });
      // For websocket upgrades, return DO response as-is. Re-wrapping 101 responses can
      // cause client-side transport instability in some browsers.
      return response;
    }

    return jsonError("NOT_FOUND", "Route not found", 404);
  },
};

export { SignalingRoomDO, RateLimitDO };

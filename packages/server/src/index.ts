import { hmacSha1Base64 } from "./crypto-utils";
import { signJoinToken, parseBearerToken, verifyJoinToken } from "./join-token";
import { RateLimitDO } from "./do/rate-limit-do";
import { SignalingRoomDO } from "./do/signaling-room-do";
import type { Env } from "./types";

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

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-internal-secret,x-dev-issuer-secret",
};

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

function extractRoomIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
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
  async fetch(request: Request, env: Env): Promise<Response> {
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
    if (roomId && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const token = parseTokenFromRequest(request, url);
      if (!token) {
        return jsonError("UNAUTHORIZED", "Missing token for websocket", 401);
      }

      let payload;
      try {
        payload = await verifyJoinToken(token, env.JOIN_TOKEN_SECRET, { expectedRoom: roomId });
      } catch (error) {
        return jsonError("UNAUTHORIZED", String((error as Error).message), 401);
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

      const response = await roomStub.fetch(doRequest);
      return withCors(response);
    }

    return jsonError("NOT_FOUND", "Route not found", 404);
  },
};

export { SignalingRoomDO, RateLimitDO };

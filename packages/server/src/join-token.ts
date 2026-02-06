import { fromBase64Url, hmacSha256, toBase64Url, toUtf8Bytes } from "./crypto-utils";

export interface JoinTokenPayload {
  sub: string;
  room: string;
  name?: string;
  exp: number;
  iat?: number;
  jti?: string;
}

interface JoinTokenHeader {
  alg: "HS256";
  typ: "JWT";
}

const header: JoinTokenHeader = {
  alg: "HS256",
  typ: "JWT",
};

export async function signJoinToken(payload: JoinTokenPayload, secret: string): Promise<string> {
  const encodedHeader = toBase64Url(toUtf8Bytes(JSON.stringify(header)));
  const encodedPayload = toBase64Url(toUtf8Bytes(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSha256(secret, signingInput);
  const encodedSignature = toBase64Url(signature);
  return `${signingInput}.${encodedSignature}`;
}

export interface VerifyOptions {
  expectedRoom?: string;
  nowEpochSeconds?: number;
}

export async function verifyJoinToken(
  token: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<JoinTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = toBase64Url(await hmacSha256(secret, signingInput));

  if (!timingSafeEqual(fromBase64Url(encodedSignature), fromBase64Url(expectedSignature))) {
    throw new Error("Invalid signature");
  }

  const parsedHeader = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedHeader))) as JoinTokenHeader;
  if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "JWT") {
    throw new Error("Unsupported token header");
  }

  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload))) as JoinTokenPayload;
  if (!payload.sub || !payload.room || typeof payload.exp !== "number") {
    throw new Error("Invalid token payload");
  }

  const nowEpochSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= nowEpochSeconds) {
    throw new Error("Token expired");
  }

  if (options.expectedRoom && payload.room !== options.expectedRoom) {
    throw new Error("Token room mismatch");
  }

  return payload;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a[i] ^ b[i];
  }
  return out === 0;
}

export function parseBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const [scheme, token] = authorizationHeader.split(" ");
  if (!scheme || !token) {
    return null;
  }
  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

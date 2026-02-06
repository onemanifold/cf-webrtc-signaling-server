interface RateLimitRequest {
  key: string;
  max: number;
  windowSec: number;
}

interface RateLimitBucket {
  count: number;
  windowStartMs: number;
}

interface RateLimitResponse {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

function bucketKey(key: string): string {
  return `bucket:${key}`;
}

function isRateLimitRequest(value: unknown): value is RateLimitRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.max === "number" &&
    Number.isFinite(candidate.max) &&
    candidate.max > 0 &&
    typeof candidate.windowSec === "number" &&
    Number.isFinite(candidate.windowSec) &&
    candidate.windowSec > 0
  );
}

export class RateLimitDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = (await request.json().catch(() => null)) as unknown;
    if (!isRateLimitRequest(body)) {
      return new Response("Invalid request", { status: 400 });
    }

    const now = Date.now();
    const windowMs = Math.floor(body.windowSec * 1_000);
    const key = bucketKey(body.key);

    let bucket = await this.state.storage.get<RateLimitBucket>(key);
    if (!bucket || now - bucket.windowStartMs >= windowMs) {
      bucket = {
        count: 0,
        windowStartMs: now,
      };
    }

    let allowed = false;
    if (bucket.count < body.max) {
      bucket.count += 1;
      allowed = true;
      await this.state.storage.put(key, bucket);
    } else {
      await this.state.storage.put(key, bucket);
    }

    const resetAt = bucket.windowStartMs + windowMs;
    const remaining = Math.max(0, body.max - bucket.count);

    const response: RateLimitResponse = {
      allowed,
      remaining,
      resetAt,
    };

    return Response.json(response);
  }
}

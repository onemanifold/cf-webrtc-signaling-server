export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  JOIN_TOKEN_SECRET: string;
  INTERNAL_API_SECRET: string;
  DEV_ISSUER_SECRET?: string;
  ALLOW_DEV_TOKEN_ISSUER?: string;
  TURN_URLS?: string;
  TURN_SHARED_SECRET?: string;
  TURN_TTL_SECONDS?: string;
  TURN_RATE_LIMIT_MAX?: string;
  TURN_RATE_LIMIT_WINDOW_SEC?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

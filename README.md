# Cloudflare DO WebRTC Signaling + Client SDK

This repository contains:
- A Cloudflare Worker + Durable Objects signaling backend.
- A reusable TypeScript client library for signaling and WebRTC mesh negotiation.
- A static P2P test app deployable to GitHub Pages.
- Guided deployment automation for Cloudflare.

## Requirements Implemented
- Browser + Node-capable signaling client.
- Per-room alias discovery (`alias -> peerId`) for online peers.
- Peer-ID based signaling.
- Short-lived join token auth.
- Trickle ICE, renegotiation, glare handling (perfect negotiation pattern).
- App-level message IDs with ACK/retry on signaling server.
- Session resume within TTL (default 30 seconds).
- TURN credentials endpoint with per-user rate limiting.
- Monorepo split (`packages/server`, `packages/client`) with tests.

## Repository Layout
- `packages/server`: Worker + Durable Objects
- `packages/client`: Signaling and WebRTC mesh SDK
- `apps/p2p-test`: static browser test app (`dist/index.html` build target)
- `scripts/deploy-guided.mjs`: interactive Cloudflare deploy script
- `scripts/ci-deploy-worker.mjs`: CI deploy hook script with optional `credentials.json`
- `scripts/smoke-signal.mjs`: local protocol smoke test

## Local Development
1. Install dependencies:
```bash
npm install
```

2. Create local secrets for Worker development:
```bash
cp packages/server/.dev.vars.example packages/server/.dev.vars
```
Update values in `packages/server/.dev.vars`.

3. Enable local token issuance (for smoke/dev):
In `packages/server/wrangler.toml`, set:
```toml
ALLOW_DEV_TOKEN_ISSUER = "true"
```

4. Run Worker locally:
```bash
npm run -w @cf-webrtc/server dev
```

5. Run smoke test in another shell:
```bash
BASE_URL=http://127.0.0.1:8787 INTERNAL_API_SECRET=... npm run smoke:local
```

## Guided Deployment
Run:
```bash
npm run deploy:guided
```

The script asks for:
- Cloudflare auth mode: OAuth login or API token + account ID.
- Worker name and runtime vars.
- Secrets (`JOIN_TOKEN_SECRET`, `INTERNAL_API_SECRET`, optional TURN/dev issuer secrets).

Then it:
- Updates `packages/server/wrangler.toml`.
- Uploads secrets using `wrangler secret put`.
- Deploys with `wrangler deploy`.

## Static P2P Test App (GitHub Pages)
Build output target is `apps/p2p-test/dist/index.html` (with static assets in the same `dist/` folder).

Build locally:
```bash
npm run build:p2p-app
```

Preview locally:
```bash
npm run -w @cf-webrtc/p2p-test preview
```

The app lets you:
- Issue dev join tokens (`/token/issue`)
- Connect to room signaling
- Claim/resolve alias in-room
- Start camera/microphone
- Exchange chat messages over RTC data channels

GitHub Pages deployment hook:
- Workflow: `.github/workflows/pages.yml`
- Trigger: push to `main` touching app/client files (or manual dispatch)
- Optional repo variable: `P2P_WORKER_URL` (sets default Worker URL in the hosted app)

### What link do peers share?
Use the GitHub Pages URL. Recommended format:
`https://<github-user>.github.io/<repo>/?worker=https://<worker>.workers.dev&room=<room-id>`

The app includes a **Copy Share Link** button that generates this URL from the current form values.

## Cloudflare Deploy Hook (GitHub Actions)
Worker deployment hook:
- Workflow: `.github/workflows/deploy-worker.yml`
- Trigger: push to `main` touching server/deploy files (or manual dispatch)

It runs:
```bash
npm run deploy:ci-worker
```

### Credentials resolution order
`scripts/ci-deploy-worker.mjs` uses:
1. `credentials.json` (if present at repo root, or path in `CF_CREDENTIALS_FILE`)
2. GitHub Action env/secrets fallback

If `credentials.json` exists, it overrides env values for keys it contains.

### Auto deploy on local config change (gitignored file)
Yes, this is possible locally even if `credentials.json` is gitignored.

Run:
```bash
npm run deploy:watch-config
```

Behavior:
- Watches `credentials.json`
- On create/update, runs `scripts/ci-deploy-worker.mjs`
- Deploys Worker automatically with your local credentials

Note:
- A gitignored file cannot trigger push-based GitHub Actions by itself.
- This watcher gives you the same “change config -> auto deploy” flow on your machine.

### Pushing only to your own fork remote
If you keep an `upstream` remote, set your fork as default push target:
```bash
git config remote.pushDefault origin
git config branch.main.pushRemote origin
```

Optional hard block on upstream pushes:
```bash
git remote set-url --push upstream DISABLED
```

Example format:
```json
{
  "cloudflare": {
    "apiToken": "CF_API_TOKEN",
    "accountId": "CF_ACCOUNT_ID",
    "workerName": "cf-webrtc-signaling"
  },
  "vars": {
    "ALLOW_DEV_TOKEN_ISSUER": "false",
    "TURN_URLS": "turn:turn.example.com:3478?transport=udp",
    "TURN_TTL_SECONDS": "3600",
    "TURN_RATE_LIMIT_MAX": "10",
    "TURN_RATE_LIMIT_WINDOW_SEC": "60"
  },
  "secrets": {
    "JOIN_TOKEN_SECRET": "required",
    "INTERNAL_API_SECRET": "required",
    "DEV_ISSUER_SECRET": "optional",
    "TURN_SHARED_SECRET": "optional"
  }
}
```

Also provided: `credentials.example.json`.

## Protocol Summary
### WebSocket endpoint
- `wss://<worker>/ws/:roomId?token=<joinToken>[&resumeToken=<token>]`

### Client -> Server
- `discovery.claim` `{ name }`
- `discovery.resolve` `{ name }`
- `signal.send` `{ toPeerId, payload, deliveryId? }`
- `signal.ack` `{ deliveryId, toPeerId }`
- `heartbeat.ping` `{ ts }`

### Server -> Client
- `session.welcome`
- `presence.joined`, `presence.left`
- `discovery.claimed`, `discovery.resolved`
- `signal.message`, `signal.acked`
- `heartbeat.pong`, `error`

## Client SDK Usage
```ts
import { SignalingClient, WebRTCMeshClient } from "@cf-webrtc/client";

const signaling = new SignalingClient({
  wsBaseUrl: "wss://your-worker.workers.dev/ws",
  httpBaseUrl: "https://your-worker.workers.dev",
  roomId: "room-1",
  alias: "alice",
  getJoinToken: async () => fetch("/api/join-token").then((r) => r.text()),
});

await signaling.connect();

const mesh = new WebRTCMeshClient({
  signaling,
  autoCreateDataChannel: true,
});

await mesh.start();
```

## Scripts
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run build:p2p-app`
- `npm run deploy:guided`
- `npm run deploy:ci-worker`
- `npm run deploy:watch-config`
- `npm run smoke:local`

## Security Notes
- `/token/issue` is for development/integration and guarded by `INTERNAL_API_SECRET` + `ALLOW_DEV_TOKEN_ISSUER`.
- In production, issue join tokens from your trusted backend.
- Do not expose `INTERNAL_API_SECRET`, `JOIN_TOKEN_SECRET`, or TURN shared secret to clients.

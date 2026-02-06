# Cloudflare Durable Object WebRTC Signaling + Client SDK

Monorepo:
- `packages/server`: Cloudflare Worker + Durable Objects signaling server.
- `packages/client`: TypeScript signaling/WebRTC client SDK.
- `apps/p2p-test`: static Vite app for end-to-end P2P testing (`dist/index.html` build target).

## Start Here (Fully Automated)
Use this if you want everything ready quickly.

Prerequisites:
- Node.js 20+
- Cloudflare account
- Optional but recommended for one-shot GitHub publish: `gh` CLI authenticated (`gh auth login`)
- Wrangler is managed by this repo (`wrangler@4` in devDependencies). Use local commands via `npx wrangler` or npm scripts.

1. Install dependencies:
```bash
npm install
```

2. Run guided bootstrap:
```bash
npm run deploy:guided
```

Or run full lifecycle (reset + deploy) from one command:
```bash
npm run lifecycle:e2e
```

3. Optional (skip token prompt):
```bash
node scripts/deploy-guided.mjs --cf-api-token <CLOUDFLARE_API_TOKEN>
```

What the guided script does:
- Deploys Worker + Durable Objects.
- Verifies Worker health at `https://<worker>.<subdomain>.workers.dev/health`.
- Writes local `credentials.json` (gitignored).
- Optionally bootstraps GitHub repo/environment/secrets/variables.
- Builds the Vite P2P app.
- Optionally triggers and waits for Worker + Pages workflows.
- Verifies GitHub Pages URL and prints share/invite links.
- Auto-generates `JOIN_TOKEN_SECRET` and `INTERNAL_API_SECRET` when not provided.
- Accepts manual secret overrides (`--join-token-secret`, `--internal-api-secret`).
- Enables `/token/issue` by default so testing works immediately (you can disable it).

## Workflow Model (Authors vs Forks)
- This repo has no hardcoded central authority in Git; "production" is whichever remote/workflow you choose.
- Author workflow: maintainers can use the upstream repo for both testing and production publishing by convention.
- Consumer workflow: users fork, clone, and deploy to their own Cloudflare account + GitHub repo using `deploy:guided` (or manual setup).
- `credentials.json` is local and gitignored, so each fork/repo can keep its own deploy credentials/state.

## Reset Without Deleting Repo
- Preview reset actions:
```bash
npm run reset:dry-run
```
- Preview lifecycle reset phase (no deploy):
```bash
npm run lifecycle:dry-run
```
- Run guided reset:
```bash
npm run reset:guided
```
- Default reset now aims to restore pre-deploy state:
  - removes local `credentials.json` + artifacts
  - restores tracked deploy files from `HEAD`
  - undeploys Worker
  - tears down GitHub bootstrap state (Pages, env secret, repo vars, environment)
  - logs out Wrangler OAuth
- Keep reset local-only:
```bash
node scripts/reset-guided.mjs --local-only
```

## Cloudflare Login + Token (Practical Path)
`deploy:guided` now prints these exact steps and opens the token page automatically when it needs a token.

1. Open `https://dash.cloudflare.com`.
2. Sign in with GitHub (supported).
3. Open `https://dash.cloudflare.com/profile/api-tokens`.
4. Create token with permission: `Account -> Workers Scripts -> Edit`.
5. Paste token into `deploy:guided` when prompted.

Notes:
- `deploy:guided` supports OAuth (`wrangler login`) for local deploy and verifies it early.
- Full CI/GitHub automation still needs an API token for secrets.
- If OAuth is selected and you are not logged in, `deploy:guided` starts `wrangler login` automatically.

## Manual Setup: GitHub Pages + GitHub Actions
Use this if you want full manual control on GitHub.

1. Copy credentials template and fill values:
```bash
cp credentials.example.json credentials.json
```

2. Deploy Worker locally once (now supports token prompt, account auto-detect, secret generation fallback):
```bash
npm run deploy:ci-worker
```

3. Create a GitHub environment named `production`.

4. Add environment secret `CF_CREDENTIALS_JSON` with the full `credentials.json` contents.

5. Add repository variable `P2P_WORKER_URL` set to:
```text
https://<worker-name>.<subdomain>.workers.dev
```

6. Push to `main` and run workflows:
- `.github/workflows/deploy-worker.yml`
- `.github/workflows/pages.yml`

7. Share:
```text
https://<github-user>.github.io/<repo>/?worker=https://<worker-name>.<subdomain>.workers.dev&room=<room-id>
```

## Manual Setup: Any Git Provider + Any Static Host
This stack is provider-agnostic.

1. Deploy Worker from CI/CD or local shell (same seamless Cloudflare flow):
```bash
node scripts/ci-deploy-worker.mjs
```
Behavior:
- Uses `credentials.json` when present.
- Otherwise uses env/CLI values.
- If token exists but account ID is missing, it auto-resolves account from Cloudflare API.
- Automatically generates missing `JOIN_TOKEN_SECRET` and `INTERNAL_API_SECRET`.
- Manual secret override is supported via CLI/env/credentials.

Useful non-interactive flags:
```bash
node scripts/ci-deploy-worker.mjs \
  --cf-api-token <TOKEN> \
  --cf-account-id <ACCOUNT_ID> \
  --worker-name <WORKER_NAME> \
  --join-token-secret <JOIN_TOKEN_SECRET> \
  --internal-api-secret <INTERNAL_API_SECRET> \
  --non-interactive
```

2. Build static app:
```bash
npm run build:p2p-app
```

3. Publish `apps/p2p-test/dist/` to any static host (S3+CloudFront, Netlify, Vercel static, Nginx, etc).

4. Configure Worker URL in one of two ways:
- Build-time env for Vite: `VITE_DEFAULT_WORKER_URL=https://<worker>.<subdomain>.workers.dev`
- Runtime query param: `?worker=https://<worker>.<subdomain>.workers.dev&room=<room-id>`

## Vite-Only Local Test Option
No custom backend is required for the app itself (it is static).

Run local app dev server:
```bash
npm run -w @cf-webrtc/p2p-test-app dev
```

Or preview production build:
```bash
npm run -w @cf-webrtc/p2p-test-app preview
```

Then point the app to your deployed Worker URL.

### Fast Two-Browser Test (Auto Join Tokens)
After deploy, generate two ready-to-open links with short-lived join tokens:
```bash
npm run test:links
```

Optional open both browser tabs automatically:
```bash
npm run test:links -- --open
```

The app also auto-issues a join token on connect if:
- the Join Token field is empty, and
- `INTERNAL_API_SECRET` is provided in the app.
- `/token/issue` is enabled (`ALLOW_DEV_TOKEN_ISSUER=true`).

## Credentials Reference
Template: `credentials.example.json`

Required:
- `cloudflare.apiToken`
- `cloudflare.accountId`
- `cloudflare.workerName`
- `secrets.JOIN_TOKEN_SECRET`
- `secrets.INTERNAL_API_SECRET`

Optional:
- TURN: `vars.TURN_URLS`, `secrets.TURN_SHARED_SECRET`
- Dev token issuer: `vars.ALLOW_DEV_TOKEN_ISSUER`, `secrets.DEV_ISSUER_SECRET`

## Key Scripts
- `npm run deploy:guided`
- `npm run deploy:ci-worker`
- `npm run gh:setup`
- `npm run build:p2p-app`
- `npm run deploy:watch-config`
- `npm run test:links`
- `npm run typecheck`
- `npm run test`
- `npm run build`

## Security
- `credentials.json` is local-only and gitignored.
- Never expose `JOIN_TOKEN_SECRET`, `INTERNAL_API_SECRET`, `TURN_SHARED_SECRET` to clients.
- `/token/issue` is dev-only and controlled by `ALLOW_DEV_TOKEN_ISSUER`.

## Billing Note
Workers has a free tier and does not require Zero Trust for this project.
If you are prompted for billing details, that is usually tied to usage-billed features beyond this minimal setup.

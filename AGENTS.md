# Agent Runbook

Use these commands for reliable automation in this repo.

## Preferred Lifecycle Commands
- Full lifecycle (reset + deploy):
```bash
npm run lifecycle:e2e
```
- Safe preview (reset dry-run, deploy skipped):
```bash
npm run lifecycle:dry-run
```

## Deterministic Non-Interactive Mode
For CI/agents, prefer API token mode:
```bash
node scripts/lifecycle-e2e.mjs \
  --non-interactive \
  --auth-mode api \
  --cf-api-token <CLOUDFLARE_API_TOKEN> \
  --repo <owner/repo> \
  --branch main
```

## OAuth Caveat
- OAuth browser login can be fragile in detached PTY sessions.
- If OAuth is required, run it first:
```bash
npx wrangler login
npx wrangler whoami --config packages/server/wrangler.toml
```
- Then run lifecycle/deploy.

## Reset Behavior
`reset:guided` defaults to full pre-deploy teardown:
- GitHub teardown (Pages, env secret, repo vars, environment)
- Worker undeploy
- Local cleanup (`credentials.json`, `.wrangler`, app dist)
- Wrangler logout

Use local-only reset when cloud teardown is not desired:
```bash
node scripts/reset-guided.mjs --local-only
```

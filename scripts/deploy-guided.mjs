#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, "packages", "server");
const WRANGLER_PATH = path.join(SERVER_DIR, "wrangler.toml");
const DEFAULT_CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const DEFAULT_GH_ENVIRONMENT = "production";

function parseCliArgs(argv) {
  const out = {
    cfApiToken: "",
    workerName: "",
    authMode: "",
    repo: "",
    branch: "",
    nonInteractive: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (["--cf-api-token", "--api-token", "--token"].includes(arg)) {
      if (!next) {
        throw new Error(`${arg} expects a value`);
      }
      out.cfApiToken = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--worker-name") {
      if (!next) {
        throw new Error("--worker-name expects a value");
      }
      out.workerName = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--auth-mode") {
      if (!next) {
        throw new Error("--auth-mode expects 'oauth' or 'api'");
      }
      out.authMode = next.trim().toLowerCase();
      i += 1;
      continue;
    }

    if (arg === "--repo") {
      if (!next) {
        throw new Error("--repo expects owner/repo");
      }
      out.repo = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--branch") {
      if (!next) {
        throw new Error("--branch expects a branch name");
      }
      out.branch = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--non-interactive") {
      out.nonInteractive = true;
      continue;
    }
  }

  return out;
}

function generateSecret() {
  return randomBytes(32).toString("base64url");
}

function quoteToml(value) {
  return JSON.stringify(String(value));
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function upsertTopLevelKey(content, key, value) {
  const line = `${key} = ${quoteToml(value)}`;
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, line);
  }

  const lines = content.split("\n");
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("[")) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

function upsertTopLevelRaw(content, key, rawValue) {
  const line = `${key} = ${rawValue}`;
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, line);
  }

  const lines = content.split("\n");
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("[")) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

function removeTopLevelKey(content, key) {
  const regex = new RegExp(`^${key}\\s*=.*\\n?`, "m");
  return content.replace(regex, "");
}

function ensureVarsSection(content) {
  if (content.includes("[vars]")) {
    return content;
  }
  const trimmed = content.endsWith("\n") ? content : `${content}\n`;
  return `${trimmed}\n[vars]\n`;
}

function upsertVar(content, key, value) {
  content = ensureVarsSection(content);
  const varLine = `${key} = ${quoteToml(value)}`;
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, varLine);
  }

  const lines = content.split("\n");
  const varsIndex = lines.findIndex((line) => line.trim() === "[vars]");
  if (varsIndex === -1) {
    lines.push("[vars]", varLine);
    return lines.join("\n");
  }

  let insertAt = varsIndex + 1;
  while (insertAt < lines.length) {
    const line = lines[insertAt].trim();
    if (line.startsWith("[")) {
      break;
    }
    insertAt += 1;
  }

  lines.splice(insertAt, 0, varLine);
  return lines.join("\n");
}

async function runCommand(command, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env,
    stdio: options.stdio ?? "inherit",
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function runCapture(command, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const err = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0) {
        resolve({ out, err });
        return;
      }
      reject(new Error(err || `${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function openBrowserUrl(url) {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  try {
    await runCommand(opener.command, opener.args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function putSecret(name, value, envOverrides) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["wrangler", "secret", "put", name, "--config", WRANGLER_PATH],
      {
        cwd: ROOT,
        env: { ...process.env, ...envOverrides },
        stdio: ["pipe", "inherit", "inherit"],
      },
    );

    child.on("error", reject);
    child.stdin.write(`${value}\n`);
    child.stdin.end();

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`wrangler secret put ${name} failed with code ${code}`));
    });
  });
}

function parseYesNo(value, fallback) {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function printTokenOnboarding() {
  output.write("\nCloudflare API token required for automated account lookup.\n");
  output.write("1. Open: https://dash.cloudflare.com (or wrangler OAuth browser page)\n");
  output.write("2. Sign in with GitHub on Cloudflare login\n");
  output.write("3. Open: https://dash.cloudflare.com/profile/api-tokens\n");
  output.write(
    "4. Create token with Account -> Workers Scripts -> Edit (scope to your account)\n",
  );
  output.write("5. Copy token and paste below (it is shown once)\n\n");
}

function normalizeSlug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseGithubRepoFromRemoteUrl(url) {
  if (!url) {
    return "";
  }
  const trimmed = url.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  return "";
}

function pagesUrl(repo) {
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/`;
}

function buildWorkerUrl(workerName, workersSubdomain) {
  if (workersSubdomain) {
    return `https://${workerName}.${workersSubdomain}.workers.dev`;
  }
  return `https://${workerName}.workers.dev`;
}

function makeShareUrl({ repo, workerUrl, roomId }) {
  return `${pagesUrl(repo)}?worker=${encodeURIComponent(workerUrl)}&room=${encodeURIComponent(roomId)}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function chooseText({ rl, prompt, defaultValue, nonInteractive }) {
  if (nonInteractive) {
    return defaultValue;
  }
  if (!defaultValue) {
    return (await rl.question(`${prompt}: `)).trim();
  }
  const value = (await rl.question(`${prompt} [${defaultValue}]: `)).trim();
  return value || defaultValue;
}

async function chooseBoolean({ rl, prompt, defaultValue, nonInteractive }) {
  if (nonInteractive) {
    return defaultValue;
  }
  const value = (await rl.question(`${prompt} (${defaultValue ? "Y/n" : "y/N"}): `)).trim();
  return parseYesNo(value, defaultValue);
}

function isJsonObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatInviteMessage({ roomId, appUrl, shareUrl }) {
  return [
    `Join my WebRTC test room \"${roomId}\".`,
    `Open app: ${appUrl}`,
    `Direct join link: ${shareUrl}`,
  ].join("\n");
}

async function fetchCloudflareAccounts(apiToken) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.success === false) {
    const apiError =
      Array.isArray(body?.errors) && body.errors[0]?.message ? String(body.errors[0].message) : "Unknown API error";
    throw new Error(`Cloudflare API account lookup failed (${response.status}): ${apiError}`);
  }

  const accounts = Array.isArray(body?.result) ? body.result : [];
  if (accounts.length === 0) {
    throw new Error("No Cloudflare accounts available for this token");
  }

  return accounts.map((account) => ({
    id: String(account.id ?? ""),
    name: String(account.name ?? ""),
  }));
}

async function fetchWorkersSubdomain(accountId, apiToken) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    const apiError =
      Array.isArray(body?.errors) && body.errors[0]?.message ? String(body.errors[0].message) : "Unknown API error";
    throw new Error(`Cloudflare workers subdomain lookup failed (${response.status}): ${apiError}`);
  }

  const subdomain = String(body?.result?.subdomain ?? "").trim();
  return subdomain;
}

async function resolveAccountFromToken(apiToken, rl, nonInteractive) {
  try {
    const accounts = await fetchCloudflareAccounts(apiToken);

    if (accounts.length === 1) {
      const only = accounts[0];
      output.write(`Auto-selected Cloudflare account: ${only.name} (${only.id})\n`);
      return only;
    }

    output.write("Cloudflare accounts available for this token:\n");
    accounts.forEach((account, index) => {
      output.write(`${index + 1}. ${account.name} (${account.id})\n`);
    });

    const selectedInput = (await rl.question(`Select account [1-${accounts.length}] [1]: `)).trim();
    const selected = selectedInput ? Number.parseInt(selectedInput, 10) : 1;

    if (!Number.isFinite(selected) || selected < 1 || selected > accounts.length) {
      throw new Error("Invalid account selection");
    }

    return accounts[selected - 1];
  } catch (error) {
    output.write(`Could not resolve account from token automatically: ${formatErrorMessage(error)}\n`);
    if (nonInteractive) {
      throw new Error("Cloudflare account lookup failed in non-interactive mode");
    }
    const manualAccountId = (await rl.question("Cloudflare account ID (manual fallback): ")).trim();
    if (!manualAccountId) {
      throw new Error("Cloudflare account ID is required");
    }
    return {
      id: manualAccountId,
      name: "manual",
    };
  }
}

async function resolveDefaultGithubRepo(cliRepo) {
  if (cliRepo) {
    return cliRepo;
  }

  try {
    const { out } = await runCapture("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    if (out) {
      return out;
    }
  } catch {
    // ignore
  }

  try {
    const { out } = await runCapture("git", ["remote", "get-url", "origin"]);
    const parsed = parseGithubRepoFromRemoteUrl(out);
    if (parsed) {
      return parsed;
    }
  } catch {
    // ignore
  }

  try {
    const { out: ghUser } = await runCapture("gh", ["api", "user", "-q", ".login"]);
    const repoName = normalizeSlug(path.basename(ROOT)) || "cf-webrtc-signaling";
    return `${ghUser}/${repoName}`;
  } catch {
    return "";
  }
}

async function verifyWorkerHealth(workerUrl) {
  const endpoint = `${workerUrl.replace(/\/+$/, "")}/health`;
  const maxAttempts = 12;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: "GET" });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        if (isJsonObject(body) && body.ok === true) {
          return;
        }
      }
    } catch {
      // retry
    }

    if (attempt < maxAttempts) {
      await sleep(3_000);
    }
  }

  throw new Error(`Worker health check failed at ${endpoint}`);
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function waitForWorkflowRun({ repo, workflowName, startedAtMs }) {
  const timeoutMs = 15 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { out } = await runCapture("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflowName,
      "--json",
      "databaseId,createdAt",
      "--limit",
      "10",
    ]);

    const runs = parseJsonArray(out);
    const matched = runs
      .filter((run) => {
        const createdAtMs = Date.parse(String(run.createdAt ?? ""));
        return Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs - 15_000;
      })
      .sort((a, b) => Date.parse(String(b.createdAt ?? "")) - Date.parse(String(a.createdAt ?? "")))[0];

    if (matched && matched.databaseId) {
      const runId = String(matched.databaseId);
      await runCommand("gh", ["run", "watch", runId, "--repo", repo, "--exit-status"]);
      const { out: viewOut } = await runCapture("gh", [
        "run",
        "view",
        runId,
        "--repo",
        repo,
        "--json",
        "url,status,conclusion",
      ]);
      const viewed = JSON.parse(viewOut);
      if (viewed.conclusion !== "success") {
        throw new Error(`${workflowName} finished with ${viewed.conclusion}: ${viewed.url}`);
      }
      return viewed.url;
    }

    await sleep(4_000);
  }

  throw new Error(`Timed out waiting for workflow run: ${workflowName}`);
}

async function verifyPagesDeployment(appUrl) {
  const maxAttempts = 24;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(appUrl, { method: "GET" });
      if (response.ok) {
        const html = await response.text();
        if (html.toLowerCase().includes("<html")) {
          return;
        }
      }
    } catch {
      // retry
    }
    if (attempt < maxAttempts) {
      await sleep(5_000);
    }
  }
  throw new Error(`GitHub Pages health check failed at ${appUrl}`);
}

function buildCredentialsPayload({
  apiToken,
  accountId,
  workersSubdomain,
  workerName,
  allowDevIssuer,
  turnUrls,
  turnTtlSeconds,
  turnRateMax,
  turnRateWindowSec,
  joinTokenSecret,
  internalApiSecret,
  devIssuerSecret,
  turnSharedSecret,
}) {
  return {
    cloudflare: {
      apiToken,
      accountId,
      subdomain: workersSubdomain || "",
      workerName,
    },
    vars: {
      ALLOW_DEV_TOKEN_ISSUER: String(allowDevIssuer),
      TURN_URLS: turnUrls,
      TURN_TTL_SECONDS: turnTtlSeconds,
      TURN_RATE_LIMIT_MAX: turnRateMax,
      TURN_RATE_LIMIT_WINDOW_SEC: turnRateWindowSec,
    },
    secrets: {
      JOIN_TOKEN_SECRET: joinTokenSecret,
      INTERNAL_API_SECRET: internalApiSecret,
      DEV_ISSUER_SECRET: devIssuerSecret || "",
      TURN_SHARED_SECRET: turnSharedSecret || "",
    },
  };
}

async function main() {
  if (!(await fileExists(WRANGLER_PATH))) {
    throw new Error(`Missing wrangler config at ${WRANGLER_PATH}`);
  }

  const args = parseCliArgs(process.argv.slice(2));
  const tokenFromArg = args.cfApiToken || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";
  const nonInteractive = args.nonInteractive;

  const rl = readline.createInterface({ input, output });

  try {
    const workerName =
      args.workerName ||
      (await chooseText({
        rl,
        prompt: "Worker name",
        defaultValue: "cf-webrtc-signaling",
        nonInteractive,
      }));

    const inferredAuthMode = "api";
    const authModeInput = (
      args.authMode ||
      (await chooseText({
        rl,
        prompt: "Auth mode: 1) API token 2) wrangler login (OAuth)",
        defaultValue: inferredAuthMode === "api" ? "1" : "2",
        nonInteractive,
      }))
    )
      .trim()
      .toLowerCase();

    let authMode = inferredAuthMode;
    if (authModeInput === "1" || authModeInput === "api") {
      authMode = "api";
    } else if (authModeInput === "2" || authModeInput === "oauth") {
      authMode = "oauth";
    }

    let accountId = "";
    let accountName = "";
    let apiToken = tokenFromArg;
    let workersSubdomain = "";

    if (authMode === "api") {
      if (!apiToken) {
        printTokenOnboarding();
        const opened = await openBrowserUrl("https://dash.cloudflare.com");
        if (opened) {
          output.write("Opened Cloudflare dashboard in your browser.\n");
        }
        apiToken = (await rl.question("Cloudflare API token (paste): ")).trim();
      }
      if (!apiToken) {
        throw new Error("API token is required for API auth mode");
      }

      const selectedAccount = await resolveAccountFromToken(apiToken, rl, nonInteractive);
      accountId = selectedAccount.id;
      accountName = selectedAccount.name;
      try {
        workersSubdomain = await fetchWorkersSubdomain(accountId, apiToken);
        if (workersSubdomain) {
          output.write(`Detected workers.dev subdomain: ${workersSubdomain}\n`);
        }
      } catch (error) {
        output.write(`Workers subdomain lookup skipped: ${formatErrorMessage(error)}\n`);
      }
    } else {
      accountId = (
        await chooseText({
          rl,
          prompt: "Cloudflare account ID (for CI credentials, optional)",
          defaultValue: "",
          nonInteractive,
        })
      ).trim();
    }

    const joinTokenSecretInput = (
      await chooseText({
        rl,
        prompt: "JOIN_TOKEN_SECRET (leave blank to generate)",
        defaultValue: "",
        nonInteractive,
      })
    ).trim();
    const joinTokenSecret = joinTokenSecretInput || generateSecret();

    const internalApiSecretInput = (
      await chooseText({
        rl,
        prompt: "INTERNAL_API_SECRET (leave blank to generate)",
        defaultValue: "",
        nonInteractive,
      })
    ).trim();
    const internalApiSecret = internalApiSecretInput || generateSecret();

    const allowDevIssuer = await chooseBoolean({
      rl,
      prompt: "Enable /token/issue dev endpoint?",
      defaultValue: false,
      nonInteractive,
    });

    let devIssuerSecret = "";
    if (allowDevIssuer) {
      const inputSecret = (
        await chooseText({
          rl,
          prompt: "DEV_ISSUER_SECRET (leave blank to generate)",
          defaultValue: "",
          nonInteractive,
        })
      ).trim();
      devIssuerSecret = inputSecret || generateSecret();
    }

    const turnUrls = (
      await chooseText({
        rl,
        prompt: "TURN_URLS (comma-separated, blank to disable TURN)",
        defaultValue: "",
        nonInteractive,
      })
    ).trim();

    let turnSharedSecret = "";
    if (turnUrls) {
      const shared = (
        await chooseText({
          rl,
          prompt: "TURN_SHARED_SECRET (leave blank to generate)",
          defaultValue: "",
          nonInteractive,
        })
      ).trim();
      turnSharedSecret = shared || generateSecret();
    }

    const turnTtlSeconds = await chooseText({
      rl,
      prompt: "TURN credential TTL seconds",
      defaultValue: "3600",
      nonInteractive,
    });
    const turnRateMax = await chooseText({
      rl,
      prompt: "TURN rate limit max requests",
      defaultValue: "10",
      nonInteractive,
    });
    const turnRateWindowSec = await chooseText({
      rl,
      prompt: "TURN rate limit window seconds",
      defaultValue: "60",
      nonInteractive,
    });

    const shouldDeploy = await chooseBoolean({
      rl,
      prompt: "Run Worker deploy now?",
      defaultValue: true,
      nonInteractive,
    });

    let wranglerContent = await readFile(WRANGLER_PATH, "utf8");
    wranglerContent = upsertTopLevelKey(wranglerContent, "name", workerName);
    wranglerContent = upsertTopLevelRaw(wranglerContent, "preview_urls", "false");

    if (authMode === "api") {
      wranglerContent = upsertTopLevelKey(wranglerContent, "account_id", accountId);
    } else {
      wranglerContent = removeTopLevelKey(wranglerContent, "account_id");
    }

    wranglerContent = upsertVar(wranglerContent, "ALLOW_DEV_TOKEN_ISSUER", String(allowDevIssuer));
    wranglerContent = upsertVar(wranglerContent, "TURN_TTL_SECONDS", turnTtlSeconds);
    wranglerContent = upsertVar(wranglerContent, "TURN_RATE_LIMIT_MAX", turnRateMax);
    wranglerContent = upsertVar(wranglerContent, "TURN_RATE_LIMIT_WINDOW_SEC", turnRateWindowSec);
    wranglerContent = upsertVar(wranglerContent, "TURN_URLS", turnUrls);

    await writeFile(WRANGLER_PATH, wranglerContent, "utf8");

    const envOverrides =
      authMode === "api"
        ? {
            CF_ACCOUNT_ID: accountId,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CF_API_TOKEN: apiToken,
            CLOUDFLARE_API_TOKEN: apiToken,
          }
        : {};

    if (authMode === "oauth") {
      try {
        await runCommand("npx", ["wrangler", "whoami", "--config", WRANGLER_PATH], { env: envOverrides });
      } catch {
        await runCommand("npx", ["wrangler", "login"], { env: envOverrides });
      }
    }

    await putSecret("JOIN_TOKEN_SECRET", joinTokenSecret, envOverrides);
    await putSecret("INTERNAL_API_SECRET", internalApiSecret, envOverrides);

    if (allowDevIssuer && devIssuerSecret) {
      await putSecret("DEV_ISSUER_SECRET", devIssuerSecret, envOverrides);
    }

    if (turnUrls && turnSharedSecret) {
      await putSecret("TURN_SHARED_SECRET", turnSharedSecret, envOverrides);
    }

    const workerUrl = buildWorkerUrl(workerName, workersSubdomain);

    if (shouldDeploy) {
      await runCommand("npx", ["wrangler", "deploy", "--config", WRANGLER_PATH], { env: envOverrides });
      output.write("\nDeploy completed.\n");
      output.write(`Verifying Worker health at ${workerUrl}/health ...\n`);
      await verifyWorkerHealth(workerUrl);
      output.write("Worker health check passed.\n");
    } else {
      output.write("\nConfiguration and secrets are set. Deploy skipped.\n");
    }

    const credentialsPath = await chooseText({
      rl,
      prompt: "Credentials JSON path",
      defaultValue: path.relative(ROOT, DEFAULT_CREDENTIALS_PATH),
      nonInteractive,
    });
    const resolvedCredentialsPath = path.resolve(ROOT, credentialsPath);

    let tokenForCredentials = apiToken;
    if (!tokenForCredentials) {
      const shouldCaptureToken = await chooseBoolean({
        rl,
        prompt: "Capture Cloudflare API token for CI/GitHub deploy automation?",
        defaultValue: true,
        nonInteractive,
      });
      if (shouldCaptureToken) {
        printTokenOnboarding();
        const opened = await openBrowserUrl("https://dash.cloudflare.com");
        if (opened) {
          output.write("Opened Cloudflare dashboard in your browser.\n");
        }
        tokenForCredentials = (await rl.question("Cloudflare API token (paste): ")).trim();
        if (tokenForCredentials && !accountId) {
          const selectedAccount = await resolveAccountFromToken(tokenForCredentials, rl, nonInteractive);
          accountId = selectedAccount.id;
          accountName = selectedAccount.name;
        }
      }
    }

    const shouldWriteCredentials = await chooseBoolean({
      rl,
      prompt: "Write local credentials.json (gitignored) for CI/automation?",
      defaultValue: true,
      nonInteractive,
    });

    if (shouldWriteCredentials) {
      const payload = buildCredentialsPayload({
        apiToken: tokenForCredentials,
        accountId,
        workersSubdomain,
        workerName,
        allowDevIssuer,
        turnUrls,
        turnTtlSeconds,
        turnRateMax,
        turnRateWindowSec,
        joinTokenSecret,
        internalApiSecret,
        devIssuerSecret,
        turnSharedSecret,
      });
      await writeFile(resolvedCredentialsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      output.write(`Wrote credentials file: ${resolvedCredentialsPath}\n`);
    }

    const canRunGithubAutomation = shouldWriteCredentials && tokenForCredentials && accountId;
    const wantsGithubAutomation = await chooseBoolean({
      rl,
      prompt: "Run GitHub bootstrap + build + Pages/Worker publish now?",
      defaultValue: Boolean(canRunGithubAutomation),
      nonInteractive,
    });

    let targetRepo = "";
    let officialBranch = "";
    let appUrl = "";
    let inviteRoom = "";

    if (wantsGithubAutomation) {
      if (!canRunGithubAutomation) {
        throw new Error(
          "GitHub automation requires credentials with Cloudflare API token + account ID. Re-run with API token mode or provide token when prompted.",
        );
      }

      await runCapture("gh", ["--version"]);
      await runCapture("gh", ["auth", "status"]);

      const repoDefault = args.repo || (await resolveDefaultGithubRepo(""));
      if (!repoDefault && nonInteractive) {
        throw new Error("--repo is required in non-interactive mode when repository cannot be inferred");
      }
      targetRepo = await chooseText({
        rl,
        prompt: "Target GitHub repo (owner/repo)",
        defaultValue: repoDefault || "owner/repo",
        nonInteractive,
      });

      officialBranch = await chooseText({
        rl,
        prompt: "Official deployment branch",
        defaultValue: args.branch || "main",
        nonInteractive,
      });
      const shouldCreatePrivate = await chooseBoolean({
        rl,
        prompt: "Create private repo if missing?",
        defaultValue: true,
        nonInteractive,
      });

      output.write("\nRunning GitHub bootstrap...\n");
      await runCommand("node", [
        "scripts/gh-setup.mjs",
        "--repo",
        targetRepo,
        "--credentials-file",
        resolvedCredentialsPath,
        "--environment",
        DEFAULT_GH_ENVIRONMENT,
        "--branch",
        officialBranch,
        "--create-private",
        String(shouldCreatePrivate),
        "--trigger-workflows",
        "false",
        "--non-interactive",
      ]);

      output.write("Building P2P app locally...\n");
      await runCommand("npm", ["run", "build:p2p-app"]);

      const workflowsStart = Date.now();
      output.write("Triggering GitHub workflows (Worker + Pages)...\n");
      await runCommand("gh", ["workflow", "run", "deploy-worker.yml", "--repo", targetRepo]);
      await runCommand("gh", ["workflow", "run", "pages.yml", "--repo", targetRepo]);

      output.write("Waiting for deploy-worker.yml...\n");
      const workerRunUrl = await waitForWorkflowRun({
        repo: targetRepo,
        workflowName: "deploy-worker.yml",
        startedAtMs: workflowsStart,
      });
      output.write(`Worker workflow success: ${workerRunUrl}\n`);

      output.write("Waiting for pages.yml...\n");
      const pagesRunUrl = await waitForWorkflowRun({
        repo: targetRepo,
        workflowName: "pages.yml",
        startedAtMs: workflowsStart,
      });
      output.write(`Pages workflow success: ${pagesRunUrl}\n`);

      appUrl = pagesUrl(targetRepo);
      output.write(`Verifying GitHub Pages URL ${appUrl} ...\n`);
      await verifyPagesDeployment(appUrl);
      output.write("GitHub Pages health check passed.\n");

      inviteRoom = await chooseText({
        rl,
        prompt: "Default room for invitation link",
        defaultValue: "main-room",
        nonInteractive,
      });
    }

    output.write("\nSummary:\n");
    output.write(`- Worker: ${workerName}\n`);
    output.write(`- Worker URL: ${workerUrl}\n`);
    output.write(`- Wrangler config: ${WRANGLER_PATH}\n`);
    output.write(`- Auth mode: ${authMode}\n`);
    if (accountId) {
      output.write(`- Cloudflare account: ${accountName || "manual"} (${accountId})\n`);
    }
    output.write(`- Dev issuer endpoint: ${allowDevIssuer ? "enabled" : "disabled"}\n`);
    output.write(`- TURN configured: ${turnUrls ? "yes" : "no"}\n`);

    if (wantsGithubAutomation) {
      const inviteLink = makeShareUrl({
        repo: targetRepo,
        workerUrl,
        roomId: inviteRoom || "main-room",
      });
      output.write(`- GitHub repo: ${targetRepo}\n`);
      output.write(`- GitHub Pages app: ${appUrl}\n`);
      output.write(`- Peer invite link: ${inviteLink}\n`);
      output.write("\nInvite message:\n");
      output.write(`${formatInviteMessage({ roomId: inviteRoom || "main-room", appUrl, shareUrl: inviteLink })}\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

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
const CLOUDFLARE_DASHBOARD_URL = "https://dash.cloudflare.com";
const CLOUDFLARE_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

function parseCliArgs(argv) {
  const out = {
    cfApiToken: "",
    workerName: "",
    authMode: "",
    repo: "",
    branch: "",
    joinTokenSecret: "",
    internalApiSecret: "",
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

    if (arg === "--join-token-secret") {
      if (!next) {
        throw new Error("--join-token-secret expects a value");
      }
      out.joinTokenSecret = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--internal-api-secret") {
      if (!next) {
        throw new Error("--internal-api-secret expects a value");
      }
      out.internalApiSecret = next.trim();
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

async function runCommandWithOutput(command, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
    process.stderr.write(chunk);
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdoutChunks).toString("utf8");
      const err = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ out, err });
        return;
      }
      reject(new Error(err || `${command} ${args.join(" ")} failed with code ${code}`));
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

function printTokenOnboarding(reason) {
  output.write(`\n${reason}\n`);
  output.write("Guided token setup:\n");
  output.write(`1. Open Cloudflare dashboard: ${CLOUDFLARE_DASHBOARD_URL}\n`);
  output.write("2. Sign in (GitHub login is supported)\n");
  output.write(`3. Open API Tokens: ${CLOUDFLARE_API_TOKENS_URL}\n`);
  output.write("4. Create token with permission: Account -> Workers Scripts -> Edit\n");
  output.write("5. Scope Account Resources to your account and create token\n");
  output.write("6. Copy token (shown once) and paste below\n\n");
}

async function promptForApiToken(rl, reason, nonInteractive) {
  if (nonInteractive) {
    throw new Error(
      `${reason} In non-interactive mode, set --cf-api-token (or CLOUDFLARE_API_TOKEN). Token page: ${CLOUDFLARE_API_TOKENS_URL}`,
    );
  }
  printTokenOnboarding(reason);
  const opened = await openBrowserUrl(CLOUDFLARE_API_TOKENS_URL);
  if (opened) {
    output.write(`Opened Cloudflare API tokens page: ${CLOUDFLARE_API_TOKENS_URL}\n`);
  } else {
    output.write(`Open this URL in your browser: ${CLOUDFLARE_API_TOKENS_URL}\n`);
  }
  return (await rl.question("Cloudflare API token (paste): ")).trim();
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

function parseWorkersDevUrlFromText(text, workerName) {
  const candidates = String(text)
    .match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi)
    ?.map((entry) => entry.replace(/\/+$/, "")) ?? [];

  if (candidates.length === 0) {
    return "";
  }

  const normalizedWorker = workerName.toLowerCase();
  const exact = candidates.find((url) => {
    const host = new URL(url).hostname.toLowerCase();
    return host === `${normalizedWorker}.workers.dev` || host.startsWith(`${normalizedWorker}.`);
  });

  return exact || candidates[0];
}

function parseWorkersSubdomainFromUrl(workerUrl, workerName) {
  try {
    const host = new URL(workerUrl).hostname;
    if (!host.endsWith(".workers.dev")) {
      return "";
    }
    const withoutSuffix = host.slice(0, -".workers.dev".length);
    const prefix = `${workerName}.`;
    if (withoutSuffix === workerName) {
      return "";
    }
    if (!withoutSuffix.startsWith(prefix)) {
      return "";
    }
    return withoutSuffix.slice(prefix.length);
  } catch {
    return "";
  }
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

function wranglerNeedsLogin(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("not authenticated") ||
    lower.includes("please run `wrangler login`") ||
    lower.includes("please run wrangler login")
  );
}

async function ensureWranglerOauthAuth({ envOverrides, nonInteractive }) {
  const probe = await runCapture("npx", ["wrangler", "whoami", "--config", WRANGLER_PATH], {
    env: envOverrides,
  }).catch((error) => ({
    out: "",
    err: error instanceof Error ? error.message : String(error),
  }));

  const probeText = `${probe.out}\n${probe.err}`;
  if (!wranglerNeedsLogin(probeText)) {
    return;
  }

  if (nonInteractive) {
    throw new Error(
      "Wrangler OAuth login is required but this shell is non-interactive. Use auth mode 1 (API token).",
    );
  }

  output.write("Wrangler OAuth login required. Starting browser login...\n");
  await runCommand("npx", ["wrangler", "login"], { env: envOverrides });

  const verify = await runCapture("npx", ["wrangler", "whoami", "--config", WRANGLER_PATH], {
    env: envOverrides,
  }).catch((error) => ({
    out: "",
    err: error instanceof Error ? error.message : String(error),
  }));

  const verifyText = `${verify.out}\n${verify.err}`;
  if (wranglerNeedsLogin(verifyText)) {
    throw new Error(
      "Wrangler OAuth login did not complete. Re-run with auth mode 1 (API token), or run `npx wrangler login` manually first.",
    );
  }
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

    if (authMode === "oauth") {
      output.write("Checking Wrangler OAuth authentication...\n");
      await ensureWranglerOauthAuth({ envOverrides: {}, nonInteractive });
      output.write("Wrangler OAuth authentication verified.\n");
      output.write("API token will only be requested if you choose GitHub automation later.\n");
    }

    let accountId = "";
    let accountName = "";
    let apiToken = tokenFromArg;
    let workersSubdomain = "";

    if (authMode === "api") {
      if (!apiToken) {
        apiToken = await promptForApiToken(
          rl,
          "Cloudflare API token required for API auth mode.",
          nonInteractive,
        );
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
    }

    const joinTokenSecretInput = (
      await chooseText({
        rl,
        prompt: "JOIN_TOKEN_SECRET (leave blank to generate)",
        defaultValue: args.joinTokenSecret || process.env.JOIN_TOKEN_SECRET || "",
        nonInteractive,
      })
    ).trim();
    const joinTokenSecret = joinTokenSecretInput || generateSecret();

    const internalApiSecretInput = (
      await chooseText({
        rl,
        prompt: "INTERNAL_API_SECRET (leave blank to generate)",
        defaultValue: args.internalApiSecret || process.env.INTERNAL_API_SECRET || "",
        nonInteractive,
      })
    ).trim();
    const internalApiSecret = internalApiSecretInput || generateSecret();

    const allowDevIssuer = await chooseBoolean({
      rl,
      prompt: "Enable /token/issue dev endpoint (recommended for immediate browser testing)?",
      defaultValue: true,
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

    let turnTtlSeconds = "3600";
    let turnRateMax = "10";
    let turnRateWindowSec = "60";
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

      turnTtlSeconds = await chooseText({
        rl,
        prompt: "TURN credential TTL seconds",
        defaultValue: "3600",
        nonInteractive,
      });
      turnRateMax = await chooseText({
        rl,
        prompt: "TURN rate limit max requests",
        defaultValue: "10",
        nonInteractive,
      });
      turnRateWindowSec = await chooseText({
        rl,
        prompt: "TURN rate limit window seconds",
        defaultValue: "60",
        nonInteractive,
      });
    }

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

    await putSecret("JOIN_TOKEN_SECRET", joinTokenSecret, envOverrides);
    await putSecret("INTERNAL_API_SECRET", internalApiSecret, envOverrides);

    if (allowDevIssuer && devIssuerSecret) {
      await putSecret("DEV_ISSUER_SECRET", devIssuerSecret, envOverrides);
    }

    if (turnUrls && turnSharedSecret) {
      await putSecret("TURN_SHARED_SECRET", turnSharedSecret, envOverrides);
    }

    let workerUrl = buildWorkerUrl(workerName, workersSubdomain);

    if (shouldDeploy) {
      const deployOutput = await runCommandWithOutput("npx", ["wrangler", "deploy", "--config", WRANGLER_PATH], {
        env: envOverrides,
      });
      const detectedWorkerUrl = parseWorkersDevUrlFromText(`${deployOutput.out}\n${deployOutput.err}`, workerName);
      if (detectedWorkerUrl) {
        workerUrl = detectedWorkerUrl;
        const detectedSubdomain = parseWorkersSubdomainFromUrl(detectedWorkerUrl, workerName);
        if (detectedSubdomain) {
          workersSubdomain = detectedSubdomain;
        }
      }
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

    const shouldWriteCredentials = await chooseBoolean({
      rl,
      prompt: "Write local credentials.json (gitignored) for CI/automation?",
      defaultValue: true,
      nonInteractive,
    });

    let effectiveShouldWriteCredentials = shouldWriteCredentials;
    const hasGithubAutomationInputs = Boolean(tokenForCredentials && accountId);
    const wantsGithubAutomation = await chooseBoolean({
      rl,
      prompt: "Run GitHub bootstrap + build + Pages/Worker publish now?",
      defaultValue: hasGithubAutomationInputs,
      nonInteractive,
    });

    if (wantsGithubAutomation && !tokenForCredentials) {
      tokenForCredentials = await promptForApiToken(
        rl,
        "Cloudflare API token required for GitHub bootstrap (repo secrets + account lookup).",
        nonInteractive,
      );
      if (!tokenForCredentials) {
        throw new Error("Cloudflare API token is required for GitHub automation");
      }
    }

    if (wantsGithubAutomation && tokenForCredentials && !accountId) {
      const selectedAccount = await resolveAccountFromToken(tokenForCredentials, rl, nonInteractive);
      accountId = selectedAccount.id;
      accountName = selectedAccount.name;
    }

    if (wantsGithubAutomation && tokenForCredentials && accountId && !workersSubdomain) {
      try {
        workersSubdomain = await fetchWorkersSubdomain(accountId, tokenForCredentials);
      } catch (error) {
        output.write(`Workers subdomain lookup skipped: ${formatErrorMessage(error)}\n`);
      }
    }

    if (wantsGithubAutomation && !effectiveShouldWriteCredentials) {
      effectiveShouldWriteCredentials = true;
      output.write("Enabled credentials.json output because GitHub automation requires it.\n");
    }

    if (effectiveShouldWriteCredentials) {
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

    const canRunGithubAutomation = effectiveShouldWriteCredentials && tokenForCredentials && accountId;

    let targetRepo = "";
    let officialBranch = "";
    let appUrl = "";
    let inviteRoom = "";
    let testLinksOutput = "";

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

      if (allowDevIssuer && effectiveShouldWriteCredentials) {
        output.write("Generating ready-to-test browser links...\n");
        try {
          const { out } = await runCapture("node", [
            "scripts/create-test-links.mjs",
            "--credentials-file",
            resolvedCredentialsPath,
            "--worker-url",
            workerUrl,
            "--app-url",
            appUrl,
            "--room",
            inviteRoom || "main-room",
          ]);
          testLinksOutput = out;
          if (out) {
            output.write(`${out}\n`);
          }
        } catch (error) {
          output.write(`Could not generate browser test links automatically: ${formatErrorMessage(error)}\n`);
        }
      }
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
      if (!testLinksOutput && allowDevIssuer) {
        output.write("\nGenerate one-click browser test links with:\n");
        output.write(
          `node scripts/create-test-links.mjs --credentials-file ${resolvedCredentialsPath} --worker-url ${workerUrl} --app-url ${appUrl} --room ${inviteRoom || "main-room"}\n`,
        );
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

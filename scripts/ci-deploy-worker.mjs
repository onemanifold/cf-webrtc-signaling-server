#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = process.cwd();
const WRANGLER_PATH = path.join(ROOT, "packages", "server", "wrangler.toml");

function parseCliArgs(argv) {
  const out = {
    cfApiToken: "",
    cfAccountId: "",
    workerName: "",
    credentialsFile: "",
    writeCredentialsFile: "",
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

    if (["--cf-account-id", "--account-id"].includes(arg)) {
      if (!next) {
        throw new Error(`${arg} expects a value`);
      }
      out.cfAccountId = next.trim();
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

    if (arg === "--credentials-file") {
      if (!next) {
        throw new Error("--credentials-file expects a path");
      }
      out.credentialsFile = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--write-credentials-file") {
      if (!next) {
        throw new Error("--write-credentials-file expects a path");
      }
      out.writeCredentialsFile = next.trim();
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

function pick(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function toBoolean(value, fallback = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (["1", "true", "yes", "y"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(text)) {
    return false;
  }
  return fallback;
}

function generateSecret() {
  return randomBytes(32).toString("base64url");
}

function quoteToml(value) {
  return JSON.stringify(String(value));
}

function buildWorkerUrl(workerName, workersSubdomain) {
  if (!workerName) {
    return "";
  }
  if (workersSubdomain) {
    return `https://${workerName}.${workersSubdomain}.workers.dev`;
  }
  return `https://${workerName}.workers.dev`;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function runCommand(command, args, env = {}, stdio = "inherit") {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio,
    });
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

async function runCapture(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
    await runCommand(opener.command, opener.args, {}, "ignore");
    return true;
  } catch {
    return false;
  }
}

function printTokenOnboarding() {
  output.write("\nCloudflare API token required.\n");
  output.write("1. Open: https://dash.cloudflare.com\n");
  output.write("2. Sign in with GitHub on Cloudflare login\n");
  output.write("3. Open: https://dash.cloudflare.com/profile/api-tokens\n");
  output.write("4. Create token: Account -> Workers Scripts -> Edit\n");
  output.write("5. Paste token below\n\n");
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

function ensureVarsSection(content) {
  if (content.includes("[vars]")) {
    return content;
  }
  const trimmed = content.endsWith("\n") ? content : `${content}\n`;
  return `${trimmed}\n[vars]\n`;
}

function upsertVar(content, key, value) {
  content = ensureVarsSection(content);
  const line = `${key} = ${quoteToml(value)}`;
  const regex = new RegExp(`^${key}\\s*=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, line);
  }

  const lines = content.split("\n");
  const varsIndex = lines.findIndex((lineText) => lineText.trim() === "[vars]");
  let insertAt = varsIndex + 1;

  while (insertAt < lines.length) {
    const text = lines[insertAt].trim();
    if (text.startsWith("[")) {
      break;
    }
    insertAt += 1;
  }

  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

function getTopLevelTomlString(content, key) {
  const regex = new RegExp(`^${key}\\s*=\\s*\"([^\"]+)\"\\s*$`, "m");
  const match = content.match(regex);
  return match ? match[1] : "";
}

async function putSecret(name, value, env) {
  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name, "--config", WRANGLER_PATH], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "inherit", "inherit"],
    });

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

async function fetchCloudflareAccounts(apiToken) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    const message =
      Array.isArray(body?.errors) && body.errors[0]?.message ? String(body.errors[0].message) : "Unknown API error";
    throw new Error(`Cloudflare API account lookup failed (${response.status}): ${message}`);
  }

  const accounts = Array.isArray(body?.result) ? body.result : [];
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
    const message =
      Array.isArray(body?.errors) && body.errors[0]?.message ? String(body.errors[0].message) : "Unknown API error";
    throw new Error(`Cloudflare workers subdomain lookup failed (${response.status}): ${message}`);
  }

  return String(body?.result?.subdomain ?? "").trim();
}

async function resolveAccountId({ apiToken, preferredAccountId, interactive, rl }) {
  if (preferredAccountId) {
    return preferredAccountId;
  }

  const accounts = await fetchCloudflareAccounts(apiToken);
  if (accounts.length === 0) {
    throw new Error("No Cloudflare accounts found for this token");
  }
  if (accounts.length === 1) {
    output.write(`Auto-selected account: ${accounts[0].name} (${accounts[0].id})\n`);
    return accounts[0].id;
  }

  if (!interactive) {
    throw new Error("Token can access multiple Cloudflare accounts; provide CF_ACCOUNT_ID or --cf-account-id");
  }

  output.write("Cloudflare accounts:\n");
  for (let i = 0; i < accounts.length; i += 1) {
    output.write(`${i + 1}. ${accounts[i].name} (${accounts[i].id})\n`);
  }
  const selectedRaw = (await rl.question(`Select account [1-${accounts.length}] [1]: `)).trim();
  const selectedIndex = selectedRaw ? Number.parseInt(selectedRaw, 10) - 1 : 0;
  if (!Number.isFinite(selectedIndex) || selectedIndex < 0 || selectedIndex >= accounts.length) {
    throw new Error("Invalid account selection");
  }
  return accounts[selectedIndex].id;
}

function resolveConfig(credentials, cliArgs) {
  const cf = credentials?.cloudflare && typeof credentials.cloudflare === "object" ? credentials.cloudflare : {};
  const secrets = credentials?.secrets && typeof credentials.secrets === "object" ? credentials.secrets : {};
  const vars = credentials?.vars && typeof credentials.vars === "object" ? credentials.vars : {};

  return {
    cloudflare: {
      apiToken: pick(
        cliArgs.cfApiToken,
        cf.apiToken,
        credentials?.CLOUDFLARE_API_TOKEN,
        credentials?.CF_API_TOKEN,
        process.env.CLOUDFLARE_API_TOKEN,
        process.env.CF_API_TOKEN,
      ),
      accountId: pick(
        cliArgs.cfAccountId,
        cf.accountId,
        credentials?.CLOUDFLARE_ACCOUNT_ID,
        credentials?.CF_ACCOUNT_ID,
        process.env.CLOUDFLARE_ACCOUNT_ID,
        process.env.CF_ACCOUNT_ID,
      ),
      workersSubdomain: pick(
        cf.subdomain,
        credentials?.CLOUDFLARE_SUBDOMAIN,
        credentials?.CF_WORKERS_SUBDOMAIN,
        process.env.CLOUDFLARE_SUBDOMAIN,
        process.env.CF_WORKERS_SUBDOMAIN,
      ),
      workerName: pick(cliArgs.workerName, cf.workerName, credentials?.WORKER_NAME, process.env.WORKER_NAME),
    },
    vars: {
      ALLOW_DEV_TOKEN_ISSUER: pick(
        vars.ALLOW_DEV_TOKEN_ISSUER,
        credentials?.ALLOW_DEV_TOKEN_ISSUER,
        process.env.ALLOW_DEV_TOKEN_ISSUER,
      ),
      TURN_URLS: pick(vars.TURN_URLS, credentials?.TURN_URLS, process.env.TURN_URLS),
      TURN_TTL_SECONDS: pick(vars.TURN_TTL_SECONDS, credentials?.TURN_TTL_SECONDS, process.env.TURN_TTL_SECONDS),
      TURN_RATE_LIMIT_MAX: pick(vars.TURN_RATE_LIMIT_MAX, credentials?.TURN_RATE_LIMIT_MAX, process.env.TURN_RATE_LIMIT_MAX),
      TURN_RATE_LIMIT_WINDOW_SEC: pick(
        vars.TURN_RATE_LIMIT_WINDOW_SEC,
        credentials?.TURN_RATE_LIMIT_WINDOW_SEC,
        process.env.TURN_RATE_LIMIT_WINDOW_SEC,
      ),
    },
    secrets: {
      JOIN_TOKEN_SECRET: pick(secrets.JOIN_TOKEN_SECRET, credentials?.JOIN_TOKEN_SECRET, process.env.JOIN_TOKEN_SECRET),
      INTERNAL_API_SECRET: pick(
        secrets.INTERNAL_API_SECRET,
        credentials?.INTERNAL_API_SECRET,
        process.env.INTERNAL_API_SECRET,
      ),
      DEV_ISSUER_SECRET: pick(secrets.DEV_ISSUER_SECRET, credentials?.DEV_ISSUER_SECRET, process.env.DEV_ISSUER_SECRET),
      TURN_SHARED_SECRET: pick(secrets.TURN_SHARED_SECRET, credentials?.TURN_SHARED_SECRET, process.env.TURN_SHARED_SECRET),
    },
  };
}

async function readCredentials(credentialsPath) {
  if (!(await exists(credentialsPath))) {
    return null;
  }

  const raw = await readFile(credentialsPath, "utf8");
  const parsed = parseJsonSafe(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON in ${credentialsPath}`);
  }
  console.log(`Using credentials file: ${credentialsPath}`);
  return parsed;
}

async function verifyWorkerHealth(workerUrl) {
  const endpoint = `${workerUrl.replace(/\/+$/, "")}/health`;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload && typeof payload === "object" && payload.ok === true) {
          console.log(`Worker health check passed: ${endpoint}`);
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(`Worker health check failed: ${endpoint}`);
}

async function maybeWriteCredentials({ config, targetPath, shouldWrite }) {
  if (!shouldWrite) {
    return;
  }
  const payload = {
    cloudflare: {
      apiToken: config.cloudflare.apiToken,
      accountId: config.cloudflare.accountId,
      subdomain: config.cloudflare.workersSubdomain,
      workerName: config.cloudflare.workerName,
    },
    vars: {
      ALLOW_DEV_TOKEN_ISSUER: config.vars.ALLOW_DEV_TOKEN_ISSUER,
      TURN_URLS: config.vars.TURN_URLS,
      TURN_TTL_SECONDS: config.vars.TURN_TTL_SECONDS,
      TURN_RATE_LIMIT_MAX: config.vars.TURN_RATE_LIMIT_MAX,
      TURN_RATE_LIMIT_WINDOW_SEC: config.vars.TURN_RATE_LIMIT_WINDOW_SEC,
    },
    secrets: {
      JOIN_TOKEN_SECRET: config.secrets.JOIN_TOKEN_SECRET,
      INTERNAL_API_SECRET: config.secrets.INTERNAL_API_SECRET,
      DEV_ISSUER_SECRET: config.secrets.DEV_ISSUER_SECRET,
      TURN_SHARED_SECRET: config.secrets.TURN_SHARED_SECRET,
    },
  };
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote credentials file: ${targetPath}`);
}

async function main() {
  if (!(await exists(WRANGLER_PATH))) {
    throw new Error(`Missing wrangler config: ${WRANGLER_PATH}`);
  }

  const args = parseCliArgs(process.argv.slice(2));
  const isCi = toBoolean(process.env.CI, false);
  const interactive = Boolean(!args.nonInteractive && !isCi && process.stdin.isTTY && process.stdout.isTTY);

  const credentialsPath = args.credentialsFile
    ? path.resolve(ROOT, args.credentialsFile)
    : process.env.CF_CREDENTIALS_FILE
      ? path.resolve(ROOT, process.env.CF_CREDENTIALS_FILE)
      : path.join(ROOT, "credentials.json");

  const credentials = await readCredentials(credentialsPath);
  const config = resolveConfig(credentials, args);

  const rl = readline.createInterface({ input, output });
  try {
    if (!config.cloudflare.apiToken) {
      if (!interactive) {
        throw new Error(
          "Missing CLOUDFLARE_API_TOKEN/CF_API_TOKEN (or credentials.json cloudflare.apiToken) in non-interactive mode",
        );
      }
      printTokenOnboarding();
      const opened = await openBrowserUrl("https://dash.cloudflare.com");
      if (opened) {
        output.write("Opened Cloudflare dashboard in browser.\n");
      }
      config.cloudflare.apiToken = (await rl.question("Cloudflare API token: ")).trim();
      if (!config.cloudflare.apiToken) {
        throw new Error("Cloudflare API token is required");
      }
    }

    config.cloudflare.accountId = await resolveAccountId({
      apiToken: config.cloudflare.apiToken,
      preferredAccountId: config.cloudflare.accountId,
      interactive,
      rl,
    });

    if (!config.cloudflare.workersSubdomain) {
      try {
        config.cloudflare.workersSubdomain = await fetchWorkersSubdomain(
          config.cloudflare.accountId,
          config.cloudflare.apiToken,
        );
        if (config.cloudflare.workersSubdomain) {
          console.log(`Detected workers.dev subdomain: ${config.cloudflare.workersSubdomain}`);
        }
      } catch (error) {
        console.log(`Workers subdomain lookup skipped: ${formatErrorMessage(error)}`);
      }
    }

    let wranglerToml = await readFile(WRANGLER_PATH, "utf8");
    const wranglerName = getTopLevelTomlString(wranglerToml, "name");
    config.cloudflare.workerName = pick(config.cloudflare.workerName, wranglerName);

    if (!config.cloudflare.workerName && interactive) {
      config.cloudflare.workerName = (await rl.question("Worker name (used for deploy URL): ")).trim();
    }

    if (!config.secrets.JOIN_TOKEN_SECRET) {
      if (!interactive) {
        throw new Error("Missing JOIN_TOKEN_SECRET in non-interactive mode");
      }
      config.secrets.JOIN_TOKEN_SECRET = generateSecret();
      console.log("Generated missing JOIN_TOKEN_SECRET.");
    }

    if (!config.secrets.INTERNAL_API_SECRET) {
      if (!interactive) {
        throw new Error("Missing INTERNAL_API_SECRET in non-interactive mode");
      }
      config.secrets.INTERNAL_API_SECRET = generateSecret();
      console.log("Generated missing INTERNAL_API_SECRET.");
    }

    if (config.vars.TURN_URLS && !config.secrets.TURN_SHARED_SECRET) {
      if (!interactive) {
        throw new Error("TURN_URLS is set but TURN_SHARED_SECRET is missing in non-interactive mode");
      }
      config.secrets.TURN_SHARED_SECRET = generateSecret();
      console.log("Generated missing TURN_SHARED_SECRET.");
    }

    if (config.cloudflare.workerName) {
      wranglerToml = upsertTopLevelKey(wranglerToml, "name", config.cloudflare.workerName);
    }
    wranglerToml = upsertTopLevelKey(wranglerToml, "account_id", config.cloudflare.accountId);
    wranglerToml = upsertTopLevelRaw(wranglerToml, "preview_urls", "false");

    for (const [key, value] of Object.entries(config.vars)) {
      if (!value) {
        continue;
      }
      wranglerToml = upsertVar(wranglerToml, key, value);
    }

    await writeFile(WRANGLER_PATH, wranglerToml, "utf8");

    const wranglerEnv = {
      CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken,
      CF_API_TOKEN: config.cloudflare.apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId,
      CF_ACCOUNT_ID: config.cloudflare.accountId,
    };

    await putSecret("JOIN_TOKEN_SECRET", config.secrets.JOIN_TOKEN_SECRET, wranglerEnv);
    await putSecret("INTERNAL_API_SECRET", config.secrets.INTERNAL_API_SECRET, wranglerEnv);

    if (config.secrets.DEV_ISSUER_SECRET) {
      await putSecret("DEV_ISSUER_SECRET", config.secrets.DEV_ISSUER_SECRET, wranglerEnv);
    }

    if (config.vars.TURN_URLS && config.secrets.TURN_SHARED_SECRET) {
      await putSecret("TURN_SHARED_SECRET", config.secrets.TURN_SHARED_SECRET, wranglerEnv);
    }

    const dryRun = toBoolean(process.env.DRY_RUN, false);
    if (dryRun) {
      console.log("DRY_RUN=true, skipped wrangler deploy.");
    } else {
      await runCommand("npx", ["wrangler", "deploy", "--config", WRANGLER_PATH], wranglerEnv);
      console.log("Cloudflare Worker deploy completed.");
    }

    const writeCredentialsFromEnv = toBoolean(process.env.WRITE_CREDENTIALS, false);
    const writeCredentialsPath = args.writeCredentialsFile
      ? path.resolve(ROOT, args.writeCredentialsFile)
      : process.env.WRITE_CREDENTIALS_FILE
        ? path.resolve(ROOT, process.env.WRITE_CREDENTIALS_FILE)
        : credentialsPath;

    let shouldWriteCredentials = Boolean(args.writeCredentialsFile || writeCredentialsFromEnv);
    if (interactive && !shouldWriteCredentials) {
      const raw = (await rl.question("Write credentials.json with resolved values? (Y/n): ")).trim();
      shouldWriteCredentials = !raw || ["y", "yes"].includes(raw.toLowerCase());
    }

    await maybeWriteCredentials({
      config,
      targetPath: writeCredentialsPath,
      shouldWrite: shouldWriteCredentials,
    });

    if (!dryRun && config.cloudflare.workerName) {
      await verifyWorkerHealth(buildWorkerUrl(config.cloudflare.workerName, config.cloudflare.workersSubdomain));
    }

    if (config.cloudflare.workerName) {
      console.log(`Worker URL: ${buildWorkerUrl(config.cloudflare.workerName, config.cloudflare.workersSubdomain)}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(formatErrorMessage(error));
  process.exit(1);
});

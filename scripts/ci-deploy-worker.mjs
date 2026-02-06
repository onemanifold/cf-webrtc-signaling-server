#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const WRANGLER_PATH = path.join(ROOT, "packages", "server", "wrangler.toml");
const CREDENTIALS_PATH = process.env.CF_CREDENTIALS_FILE
  ? path.resolve(ROOT, process.env.CF_CREDENTIALS_FILE)
  : path.join(ROOT, "credentials.json");

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

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
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

function quoteToml(value) {
  return JSON.stringify(String(value));
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

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readCredentials() {
  if (!(await exists(CREDENTIALS_PATH))) {
    return null;
  }
  const raw = await readFile(CREDENTIALS_PATH, "utf8");
  const parsed = parseJsonSafe(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON in ${CREDENTIALS_PATH}`);
  }
  console.log(`Using credentials file: ${CREDENTIALS_PATH}`);
  return parsed;
}

function resolveConfig(credentials) {
  const cf = credentials?.cloudflare && typeof credentials.cloudflare === "object" ? credentials.cloudflare : {};
  const secrets = credentials?.secrets && typeof credentials.secrets === "object" ? credentials.secrets : {};
  const vars = credentials?.vars && typeof credentials.vars === "object" ? credentials.vars : {};

  const apiToken = pick(cf.apiToken, credentials?.CF_API_TOKEN, process.env.CF_API_TOKEN);
  const accountId = pick(cf.accountId, credentials?.CF_ACCOUNT_ID, process.env.CF_ACCOUNT_ID);
  const workerName = pick(cf.workerName, credentials?.WORKER_NAME, process.env.WORKER_NAME);

  const out = {
    cloudflare: {
      apiToken,
      accountId,
      workerName,
    },
    vars: {
      ALLOW_DEV_TOKEN_ISSUER: pick(vars.ALLOW_DEV_TOKEN_ISSUER, credentials?.ALLOW_DEV_TOKEN_ISSUER, process.env.ALLOW_DEV_TOKEN_ISSUER),
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
      INTERNAL_API_SECRET: pick(secrets.INTERNAL_API_SECRET, credentials?.INTERNAL_API_SECRET, process.env.INTERNAL_API_SECRET),
      DEV_ISSUER_SECRET: pick(secrets.DEV_ISSUER_SECRET, credentials?.DEV_ISSUER_SECRET, process.env.DEV_ISSUER_SECRET),
      TURN_SHARED_SECRET: pick(secrets.TURN_SHARED_SECRET, credentials?.TURN_SHARED_SECRET, process.env.TURN_SHARED_SECRET),
    },
  };

  return out;
}

async function main() {
  if (!(await exists(WRANGLER_PATH))) {
    throw new Error(`Missing wrangler config: ${WRANGLER_PATH}`);
  }

  const credentials = await readCredentials();
  const config = resolveConfig(credentials);

  if (!config.cloudflare.apiToken || !config.cloudflare.accountId) {
    throw new Error(
      "Missing Cloudflare API credentials. Provide CF_API_TOKEN and CF_ACCOUNT_ID, or credentials.json with cloudflare.apiToken/cloudflare.accountId.",
    );
  }

  const requiredSecrets = ["JOIN_TOKEN_SECRET", "INTERNAL_API_SECRET"];
  for (const name of requiredSecrets) {
    if (!config.secrets[name]) {
      throw new Error(`Missing required secret: ${name}`);
    }
  }

  const wranglerEnv = {
    CF_API_TOKEN: config.cloudflare.apiToken,
    CF_ACCOUNT_ID: config.cloudflare.accountId,
  };

  let wranglerToml = await readFile(WRANGLER_PATH, "utf8");

  if (config.cloudflare.workerName) {
    wranglerToml = upsertTopLevelKey(wranglerToml, "name", config.cloudflare.workerName);
  }
  wranglerToml = upsertTopLevelKey(wranglerToml, "account_id", config.cloudflare.accountId);

  for (const [key, value] of Object.entries(config.vars)) {
    if (!value) {
      continue;
    }
    wranglerToml = upsertVar(wranglerToml, key, value);
  }

  await writeFile(WRANGLER_PATH, wranglerToml, "utf8");

  await putSecret("JOIN_TOKEN_SECRET", config.secrets.JOIN_TOKEN_SECRET, wranglerEnv);
  await putSecret("INTERNAL_API_SECRET", config.secrets.INTERNAL_API_SECRET, wranglerEnv);

  if (config.secrets.DEV_ISSUER_SECRET) {
    await putSecret("DEV_ISSUER_SECRET", config.secrets.DEV_ISSUER_SECRET, wranglerEnv);
  }

  if (config.vars.TURN_URLS) {
    if (!config.secrets.TURN_SHARED_SECRET) {
      throw new Error("TURN_URLS is set but TURN_SHARED_SECRET is missing");
    }
    await putSecret("TURN_SHARED_SECRET", config.secrets.TURN_SHARED_SECRET, wranglerEnv);
  }

  if (String(process.env.DRY_RUN || "").toLowerCase() === "true") {
    console.log("DRY_RUN=true, skipped wrangler deploy.");
    return;
  }

  await runCommand("npx", ["wrangler", "deploy", "--config", WRANGLER_PATH], wranglerEnv);
  console.log("Cloudflare Worker deploy completed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

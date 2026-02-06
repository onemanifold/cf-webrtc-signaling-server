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

async function main() {
  if (!(await fileExists(WRANGLER_PATH))) {
    throw new Error(`Missing wrangler config at ${WRANGLER_PATH}`);
  }

  const rl = readline.createInterface({ input, output });

  try {
    const workerName = (await rl.question("Worker name [cf-webrtc-signaling]: ")).trim() || "cf-webrtc-signaling";

    const authModeInput = (await rl.question(
      "Auth mode: 1) wrangler login (OAuth) 2) API token + account ID [1]: ",
    )
      .trim()
      .toLowerCase();
    const authMode = authModeInput === "2" ? "api" : "oauth";

    let accountId = "";
    let apiToken = "";

    if (authMode === "api") {
      accountId = (await rl.question("Cloudflare account ID: ")).trim();
      apiToken = (await rl.question("Cloudflare API token: ")).trim();
      if (!accountId || !apiToken) {
        throw new Error("account ID and API token are required for API auth mode");
      }
    }

    const joinTokenSecretInput = (await rl.question("JOIN_TOKEN_SECRET (leave blank to generate): ")).trim();
    const joinTokenSecret = joinTokenSecretInput || generateSecret();

    const internalApiSecretInput = (await rl.question("INTERNAL_API_SECRET (leave blank to generate): ")).trim();
    const internalApiSecret = internalApiSecretInput || generateSecret();

    const allowDevIssuer = parseYesNo(
      (await rl.question("Enable /token/issue dev endpoint? (y/N): ")).trim(),
      false,
    );

    let devIssuerSecret = "";
    if (allowDevIssuer) {
      const inputSecret = (await rl.question("DEV_ISSUER_SECRET (leave blank to generate): ")).trim();
      devIssuerSecret = inputSecret || generateSecret();
    }

    const turnUrls = (await rl.question("TURN_URLS (comma-separated, leave blank to disable TURN): ")).trim();

    let turnSharedSecret = "";
    if (turnUrls) {
      const shared = (await rl.question("TURN_SHARED_SECRET (leave blank to generate): ")).trim();
      turnSharedSecret = shared || generateSecret();
    }

    const turnTtlSeconds = (await rl.question("TURN credential TTL seconds [3600]: ")).trim() || "3600";
    const turnRateMax = (await rl.question("TURN rate limit max requests [10]: ")).trim() || "10";
    const turnRateWindowSec = (await rl.question("TURN rate limit window seconds [60]: ")).trim() || "60";

    const shouldDeploy = parseYesNo((await rl.question("Run deploy now? (Y/n): ")).trim(), true);

    let wranglerContent = await readFile(WRANGLER_PATH, "utf8");
    wranglerContent = upsertTopLevelKey(wranglerContent, "name", workerName);

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

    const envOverrides = authMode === "api" ? { CF_ACCOUNT_ID: accountId, CF_API_TOKEN: apiToken } : {};

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

    if (shouldDeploy) {
      await runCommand("npx", ["wrangler", "deploy", "--config", WRANGLER_PATH], { env: envOverrides });
      output.write("\nDeploy completed.\n");
    } else {
      output.write("\nConfiguration and secrets are set. Deploy skipped.\n");
    }

    output.write("\nSummary:\n");
    output.write(`- Worker: ${workerName}\n`);
    output.write(`- Wrangler config: ${WRANGLER_PATH}\n`);
    output.write(`- Dev issuer endpoint: ${allowDevIssuer ? "enabled" : "disabled"}\n`);
    output.write(`- TURN configured: ${turnUrls ? "yes" : "no"}\n`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

function parseCliArgs(argv) {
  const out = {
    credentialsFile: "",
    workerUrl: "",
    appUrl: "",
    roomId: "",
    userA: "",
    userB: "",
    aliasA: "",
    aliasB: "",
    ttlSeconds: "",
    openLinks: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--credentials-file") {
      if (!next) {
        throw new Error("--credentials-file expects a value");
      }
      out.credentialsFile = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--worker-url") {
      if (!next) {
        throw new Error("--worker-url expects a value");
      }
      out.workerUrl = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--app-url") {
      if (!next) {
        throw new Error("--app-url expects a value");
      }
      out.appUrl = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--room") {
      if (!next) {
        throw new Error("--room expects a value");
      }
      out.roomId = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--user-a") {
      if (!next) {
        throw new Error("--user-a expects a value");
      }
      out.userA = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--user-b") {
      if (!next) {
        throw new Error("--user-b expects a value");
      }
      out.userB = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--alias-a") {
      if (!next) {
        throw new Error("--alias-a expects a value");
      }
      out.aliasA = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--alias-b") {
      if (!next) {
        throw new Error("--alias-b expects a value");
      }
      out.aliasB = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--ttl") {
      if (!next) {
        throw new Error("--ttl expects seconds");
      }
      out.ttlSeconds = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--open") {
      out.openLinks = true;
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
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeHttpUrl(value) {
  return value.replace(/\/+$/, "");
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env },
      stdio: "ignore",
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

async function runCapture(command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env },
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
    await runCommand(opener.command, opener.args);
    return true;
  } catch {
    return false;
  }
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

async function detectPagesUrlFromGitRemote() {
  try {
    const { out } = await runCapture("git", ["remote", "get-url", "origin"]);
    const repo = parseGithubRepoFromRemoteUrl(out);
    if (!repo) {
      return "";
    }
    const [owner, name] = repo.split("/");
    if (!owner || !name) {
      return "";
    }
    return `https://${owner}.github.io/${name}/`;
  } catch {
    return "";
  }
}

async function issueJoinToken({ workerUrl, internalSecret, roomId, userId, alias, ttlSeconds }) {
  const headers = {
    "content-type": "application/json",
  };
  if (internalSecret) {
    headers["x-internal-secret"] = internalSecret;
    headers["x-dev-issuer-secret"] = internalSecret;
  }

  const response = await fetch(`${workerUrl}/token/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      roomId,
      userId,
      name: alias,
      ttlSeconds,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 403 && bodyText.includes("DEV_ISSUER_DISABLED")) {
      throw new Error(
        "Token issue endpoint is disabled. Set ALLOW_DEV_TOKEN_ISSUER=true in credentials and redeploy first.",
      );
    }
    throw new Error(`Token issue failed (${response.status}): ${bodyText}`);
  }

  const body = JSON.parse(bodyText);
  const token = String(body?.token ?? "");
  if (!token) {
    throw new Error("Token issuer returned success but no token");
  }
  return token;
}

function buildAppLink({ appUrl, workerUrl, roomId, userId, alias, token }) {
  const url = new URL(appUrl);
  url.searchParams.set("worker", workerUrl);
  url.searchParams.set("room", roomId);
  url.searchParams.set("userId", userId);
  url.searchParams.set("alias", alias);
  url.searchParams.set("token", token);
  url.searchParams.set("autoconnect", "1");
  return url.toString();
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  const credentialsPath = args.credentialsFile
    ? path.resolve(ROOT, args.credentialsFile)
    : process.env.CF_CREDENTIALS_FILE
      ? path.resolve(ROOT, process.env.CF_CREDENTIALS_FILE)
      : path.join(ROOT, "credentials.json");

  if (!(await fileExists(credentialsPath))) {
    throw new Error(`Missing credentials file: ${credentialsPath}`);
  }

  const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  const cf = credentials?.cloudflare && typeof credentials.cloudflare === "object" ? credentials.cloudflare : {};
  const vars = credentials?.vars && typeof credentials.vars === "object" ? credentials.vars : {};
  const secrets = credentials?.secrets && typeof credentials.secrets === "object" ? credentials.secrets : {};

  const workerUrl = normalizeHttpUrl(
    pick(args.workerUrl, process.env.WORKER_URL, buildWorkerUrl(cf.workerName, cf.subdomain)),
  );
  const detectedPagesUrl = await detectPagesUrlFromGitRemote();
  const appUrl = normalizeHttpUrl(pick(args.appUrl, process.env.P2P_APP_URL, detectedPagesUrl));
  const roomId = pick(args.roomId, process.env.ROOM_ID, "main-room");
  const userA = pick(args.userA, process.env.USER_A, "alice");
  const userB = pick(args.userB, process.env.USER_B, "bob");
  const aliasA = pick(args.aliasA, process.env.ALIAS_A, "alice");
  const aliasB = pick(args.aliasB, process.env.ALIAS_B, "bob");
  const ttlSeconds = Number.parseInt(pick(args.ttlSeconds, process.env.TOKEN_TTL, "600"), 10);
  const internalSecret = pick(secrets.INTERNAL_API_SECRET, process.env.INTERNAL_API_SECRET);

  if (!workerUrl) {
    throw new Error("Could not resolve worker URL. Provide --worker-url or credentials cloudflare.* values.");
  }
  if (!appUrl) {
    throw new Error("Could not resolve app URL. Provide --app-url or set origin remote to a GitHub repo.");
  }
  if (String(vars.ALLOW_DEV_TOKEN_ISSUER).toLowerCase() !== "true") {
    console.warn(
      "Warning: credentials indicate ALLOW_DEV_TOKEN_ISSUER is not true. /token/issue may reject requests.",
    );
  }

  const tokenA = await issueJoinToken({
    workerUrl,
    internalSecret,
    roomId,
    userId: userA,
    alias: aliasA,
    ttlSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : 600,
  });
  const tokenB = await issueJoinToken({
    workerUrl,
    internalSecret,
    roomId,
    userId: userB,
    alias: aliasB,
    ttlSeconds: Number.isFinite(ttlSeconds) ? ttlSeconds : 600,
  });

  const linkA = buildAppLink({
    appUrl,
    workerUrl,
    roomId,
    userId: userA,
    alias: aliasA,
    token: tokenA,
  });
  const linkB = buildAppLink({
    appUrl,
    workerUrl,
    roomId,
    userId: userB,
    alias: aliasB,
    token: tokenB,
  });

  console.log("Ready-to-test links (open one per browser):");
  console.log(`- A (${aliasA}): ${linkA}`);
  console.log(`- B (${aliasB}): ${linkB}`);
  console.log("");
  console.log("These links include short-lived join tokens. Generate fresh links if they expire.");

  if (args.openLinks) {
    await openBrowserUrl(linkA);
    await openBrowserUrl(linkB);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

#!/usr/bin/env node
import { access, stat } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const credentialsPath = process.env.CF_CREDENTIALS_FILE
  ? path.resolve(ROOT, process.env.CF_CREDENTIALS_FILE)
  : path.join(ROOT, "credentials.json");

const credentialsDir = path.dirname(credentialsPath);
const credentialsName = path.basename(credentialsPath);

let lastMtime = 0;
let running = false;
let rerunRequested = false;
let debounceTimer = null;

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function shouldDeploy() {
  if (!(await fileExists(credentialsPath))) {
    return false;
  }
  const info = await stat(credentialsPath);
  const mtime = info.mtimeMs;
  if (mtime <= lastMtime) {
    return false;
  }
  lastMtime = mtime;
  return true;
}

async function runDeploy() {
  if (running) {
    rerunRequested = true;
    return;
  }

  running = true;
  console.log(`[watch] deploying from ${credentialsPath}`);

  const code = await new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/ci-deploy-worker.mjs"], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", resolve);
  }).catch((error) => {
    console.error(`[watch] deploy process error: ${error instanceof Error ? error.message : error}`);
    return 1;
  });

  if (code === 0) {
    console.log("[watch] deploy succeeded");
  } else {
    console.error(`[watch] deploy failed with code ${code}`);
  }

  running = false;

  if (rerunRequested) {
    rerunRequested = false;
    const deploy = await shouldDeploy();
    if (deploy) {
      await runDeploy();
    }
  }
}

async function maybeDeploy() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    const deploy = await shouldDeploy();
    if (deploy) {
      await runDeploy();
    }
  }, 500);
}

async function main() {
  console.log(`[watch] monitoring ${credentialsPath}`);
  if (!(await fileExists(credentialsPath))) {
    console.log("[watch] credentials.json not found yet; waiting for file creation");
  } else {
    await maybeDeploy();
  }

  const watcher = watch(credentialsDir, { persistent: true }, async (eventType, filename) => {
    if (!filename) {
      return;
    }
    if (filename.toString() !== credentialsName) {
      return;
    }
    if (eventType === "change" || eventType === "rename") {
      await maybeDeploy();
    }
  });

  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n[watch] stopped");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

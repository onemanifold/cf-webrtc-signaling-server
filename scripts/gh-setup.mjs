#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = process.cwd();
const GH_COMMAND_TIMEOUT_MS = 60_000;
const GH_SECRET_TIMEOUT_MS = 180_000;
const GH_ENV_OVERRIDES = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  NO_COLOR: "1",
  CLICOLOR: "0",
  FORCE_COLOR: "0",
  TERM: "dumb",
  PAGER: "cat",
  GH_PAGER: "cat",
};

function parseCliArgs(argv) {
  const out = {
    repo: "",
    credentialsFile: "",
    environment: "",
    branch: "",
    createPrivate: "",
    triggerWorkflows: "",
    nonInteractive: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--repo") {
      if (!next) {
        throw new Error("--repo expects owner/repo");
      }
      out.repo = next.trim();
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

    if (arg === "--environment") {
      if (!next) {
        throw new Error("--environment expects a name");
      }
      out.environment = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--branch") {
      if (!next) {
        throw new Error("--branch expects a name");
      }
      out.branch = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--create-private") {
      if (!next) {
        throw new Error("--create-private expects true/false");
      }
      out.createPrivate = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--trigger-workflows") {
      if (!next) {
        throw new Error("--trigger-workflows expects true/false");
      }
      out.triggerWorkflows = next.trim();
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

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeSlug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveWorkerName(repoFullName) {
  const [owner, repo] = repoFullName.split("/");
  const ownerSlug = normalizeSlug(owner).slice(0, 16) || "owner";
  const repoSlug = normalizeSlug(repo).slice(0, 22) || "repo";
  const hash = createHash("sha256").update(repoFullName).digest("hex").slice(0, 8);
  return `p2p-${ownerSlug}-${repoSlug}-${hash}`.slice(0, 63);
}

function buildWorkerUrl(workerName, workersSubdomain) {
  if (workersSubdomain) {
    return `https://${workerName}.${workersSubdomain}.workers.dev`;
  }
  return `https://${workerName}.workers.dev`;
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0;
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...GH_ENV_OVERRIDES, ...(options.env ?? {}) },
    stdio: options.stdio ?? "inherit",
  });

  return new Promise((resolve, reject) => {
    let timeoutId = null;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    const clear = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    child.on("error", reject);
    child.on("close", (code) => {
      clear();
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with code ${code}${timeoutMs > 0 ? ` (timeout ${timeoutMs}ms)` : ""}`,
        ),
      );
    });
  });
}

async function runCapture(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0;
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...GH_ENV_OVERRIDES, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    let timeoutId = null;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    const clear = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    child.on("error", reject);
    child.on("close", (code) => {
      clear();
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve({ out, err });
        return;
      }
      reject(
        new Error(
          err || `${command} ${args.join(" ")} failed with code ${code}${timeoutMs > 0 ? ` (timeout ${timeoutMs}ms)` : ""}`,
        ),
      );
    });
  });
}

async function repoExists(repo) {
  try {
    await runCapture("gh", ["repo", "view", repo, "--json", "nameWithOwner"]);
    return true;
  } catch {
    return false;
  }
}

async function ghApiWithJson(method, pathSpec, payload) {
  await new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "--method", method, pathSpec, "--input", "-"], {
      cwd: ROOT,
      env: { ...process.env, ...GH_ENV_OVERRIDES },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
    }, GH_COMMAND_TIMEOUT_MS);

    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          Buffer.concat(stderr).toString("utf8") ||
            `gh api ${pathSpec} failed or timed out (${GH_COMMAND_TIMEOUT_MS}ms)`,
        ),
      );
    });
  });
}

async function ensureEnvWithBranchPolicy(repo, envName, branch) {
  await ghApiWithJson("PUT", `repos/${repo}/environments/${envName}`, {
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  });

  try {
    await ghApiWithJson("POST", `repos/${repo}/environments/${envName}/deployment-branch-policies`, {
      name: branch,
      type: "branch",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("already exists") ||
      message.includes("Not Found") ||
      message.includes("404")
    ) {
      output.write(`Branch policy endpoint not applied (${message.trim()}). Continuing.\n`);
      return;
    }
    throw error;
  }
}

async function setSecretFromFile({ repo, envName, name, filePath }) {
  const body = await readFile(filePath, "utf8");
  await run(
    "gh",
    ["secret", "set", name, "--repo", repo, "--env", envName, "--body", body],
    { timeoutMs: GH_SECRET_TIMEOUT_MS },
  );
}

async function setVariable({ repo, name, value, envName }) {
  const args = ["variable", "set", name, "--repo", repo, "--body", value];
  if (envName) {
    args.push("--env", envName);
  }
  await run("gh", args, { timeoutMs: GH_COMMAND_TIMEOUT_MS });
}

async function ensurePagesWorkflowMode(repo) {
  const endpoint = `repos/${repo}/pages`;
  output.write("Ensuring GitHub Pages is enabled (workflow mode)...\n");

  try {
    await runCapture("gh", ["api", "--method", "POST", endpoint, "-f", "build_type=workflow"], {
      timeoutMs: GH_COMMAND_TIMEOUT_MS,
    });
    output.write("GitHub Pages enabled (workflow mode).\n");
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (
      lower.includes("already") ||
      lower.includes("unprocessable") ||
      lower.includes("422") ||
      lower.includes("409")
    ) {
      output.write("GitHub Pages already enabled.\n");
      return;
    }
  }

  try {
    const { out } = await runCapture("gh", ["api", endpoint], {
      timeoutMs: GH_COMMAND_TIMEOUT_MS,
    });
    const payload = JSON.parse(out || "{}");
    if (payload.build_type === "workflow") {
      output.write("GitHub Pages already enabled (workflow mode).\n");
      return;
    }
  } catch {
    // keep going to PUT attempt below
  }

  await runCapture("gh", ["api", "--method", "PUT", endpoint, "-f", "build_type=workflow"], {
    timeoutMs: GH_COMMAND_TIMEOUT_MS,
  });
  output.write("Updated GitHub Pages to workflow mode.\n");
}

function pagesUrl(repo) {
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/`;
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
    throw new Error(`Workers subdomain lookup failed (${response.status}): ${message}`);
  }

  return String(body?.result?.subdomain ?? "").trim();
}

async function chooseText({ rl, label, defaultValue, nonInteractive }) {
  if (nonInteractive) {
    return defaultValue;
  }
  const value = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  return value || defaultValue;
}

async function chooseBoolean({ rl, label, defaultValue, nonInteractive }) {
  if (nonInteractive) {
    return defaultValue;
  }
  const raw = (await rl.question(`${label} (${defaultValue ? "Y/n" : "y/N"}): `)).trim();
  return parseBoolean(raw, defaultValue);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const nonInteractive = args.nonInteractive;

  const { out: ghUser } = await runCapture("gh", ["api", "user", "-q", ".login"]);
  const dirName = path.basename(ROOT);
  const repoSlug = normalizeSlug(dirName) || "cf-webrtc-signaling";

  let currentRepo = "";
  try {
    const viewed = await runCapture("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    currentRepo = viewed.out;
  } catch {
    currentRepo = "";
  }

  const defaultRepo = args.repo || process.env.GH_SETUP_REPO || currentRepo || `${ghUser}/${repoSlug}`;
  const defaultEnv = args.environment || process.env.GH_DEPLOY_ENV || process.env.GH_SETUP_ENV || "production";
  const defaultBranch = args.branch || process.env.GH_SETUP_BRANCH || "main";
  const defaultCredentialsFile =
    args.credentialsFile || process.env.GH_SETUP_CREDENTIALS_FILE || "credentials.json";
  const defaultCreatePrivate = parseBoolean(
    args.createPrivate || process.env.GH_SETUP_CREATE_PRIVATE,
    true,
  );
  const defaultTriggerWorkflows = parseBoolean(
    args.triggerWorkflows || process.env.GH_SETUP_TRIGGER_WORKFLOWS,
    true,
  );

  const rl = readline.createInterface({ input, output });

  try {
    output.write("\nGitHub bootstrap for Pages + Worker deployment\n\n");

    const targetRepo = await chooseText({
      rl,
      label: "Target repository",
      defaultValue: defaultRepo,
      nonInteractive,
    });

    const shouldCreatePrivate = await chooseBoolean({
      rl,
      label: "Create private repository if missing?",
      defaultValue: defaultCreatePrivate,
      nonInteractive,
    });

    const envName = defaultEnv;
    const officialBranch = await chooseText({
      rl,
      label: "Official deployment branch",
      defaultValue: defaultBranch,
      nonInteractive,
    });

    const credentialsFileInput = await chooseText({
      rl,
      label: "Credentials JSON path",
      defaultValue: defaultCredentialsFile,
      nonInteractive,
    });
    const credentialsFile = path.resolve(ROOT, credentialsFileInput);

    if (!(await fileExists(credentialsFile))) {
      throw new Error(`Credentials file not found: ${credentialsFile}`);
    }

    let credentials;
    try {
      credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
    } catch {
      throw new Error(`Invalid JSON in ${credentialsFile}`);
    }

    const exists = await repoExists(targetRepo);
    if (!exists) {
      if (!shouldCreatePrivate) {
        throw new Error(`Repository ${targetRepo} does not exist and create option is disabled`);
      }

      await run("gh", ["repo", "create", targetRepo, "--private", "--source", ".", "--remote", "private", "--push"]);
      await run("git", ["config", "remote.pushDefault", "private"]);
      await run("git", ["config", `branch.${officialBranch}.pushRemote`, "private"]);
      output.write("Created private repository and set push default to remote 'private'.\n");
    }

    const hasWorkerName = Boolean(
      credentials &&
        credentials.cloudflare &&
        typeof credentials.cloudflare === "object" &&
        credentials.cloudflare.workerName,
    );

    const configuredWorkerName = hasWorkerName
      ? String(credentials.cloudflare.workerName)
      : deriveWorkerName(targetRepo);
    let configuredWorkersSubdomain =
      credentials &&
      credentials.cloudflare &&
      typeof credentials.cloudflare === "object" &&
      credentials.cloudflare.subdomain
        ? String(credentials.cloudflare.subdomain)
        : "";

    if (!configuredWorkersSubdomain) {
      const apiToken =
        credentials &&
        credentials.cloudflare &&
        typeof credentials.cloudflare === "object" &&
        credentials.cloudflare.apiToken
          ? String(credentials.cloudflare.apiToken)
          : "";
      const accountId =
        credentials &&
        credentials.cloudflare &&
        typeof credentials.cloudflare === "object" &&
        credentials.cloudflare.accountId
          ? String(credentials.cloudflare.accountId)
          : "";

      if (apiToken && accountId) {
        try {
          configuredWorkersSubdomain = await fetchWorkersSubdomain(accountId, apiToken);
          if (configuredWorkersSubdomain) {
            credentials.cloudflare.subdomain = configuredWorkersSubdomain;
            await writeFile(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
            output.write(`Updated credentials file with subdomain=${configuredWorkersSubdomain}.\n`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.write(`Workers subdomain lookup skipped (${message}).\n`);
        }
      }
    }

    if (!hasWorkerName) {
      credentials.cloudflare = {
        ...(credentials.cloudflare && typeof credentials.cloudflare === "object" ? credentials.cloudflare : {}),
        workerName: configuredWorkerName,
      };
      await writeFile(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      output.write(`Updated credentials file with workerName=${configuredWorkerName}.\n`);
    }

    await ensureEnvWithBranchPolicy(targetRepo, envName, officialBranch);
    output.write(`Configured environment '${envName}' with branch policy '${officialBranch}'.\n`);

    output.write("Setting environment secret CF_CREDENTIALS_JSON...\n");
    await setSecretFromFile({
      repo: targetRepo,
      envName,
      name: "CF_CREDENTIALS_JSON",
      filePath: credentialsFile,
    });
    output.write(`Set environment secret CF_CREDENTIALS_JSON on ${targetRepo}/${envName}.\n`);

    const workerUrl = buildWorkerUrl(configuredWorkerName, configuredWorkersSubdomain);
    output.write("Setting repository variable P2P_WORKER_URL...\n");
    await setVariable({ repo: targetRepo, name: "P2P_WORKER_URL", value: workerUrl });
    output.write("Setting repository variable WORKER_NAME...\n");
    await setVariable({ repo: targetRepo, name: "WORKER_NAME", value: configuredWorkerName });

    output.write(`Set repository variables: P2P_WORKER_URL=${workerUrl}, WORKER_NAME=${configuredWorkerName}\n`);
    await ensurePagesWorkflowMode(targetRepo);

    const runWorkflowsNow = await chooseBoolean({
      rl,
      label: "Trigger deploy workflows now?",
      defaultValue: defaultTriggerWorkflows,
      nonInteractive,
    });

    if (runWorkflowsNow) {
      await run("gh", ["workflow", "run", "deploy-worker.yml", "--repo", targetRepo], {
        timeoutMs: GH_COMMAND_TIMEOUT_MS,
      });
      await run("gh", ["workflow", "run", "pages.yml", "--repo", targetRepo], {
        timeoutMs: GH_COMMAND_TIMEOUT_MS,
      });
      output.write("Triggered workflows: deploy-worker.yml and pages.yml\n");
    }

    const appUrl = pagesUrl(targetRepo);
    const shareUrl = `${appUrl}?worker=${encodeURIComponent(workerUrl)}&room=main-room`;

    output.write("\nDone.\n");
    output.write(`- Repo: ${targetRepo}\n`);
    output.write(`- Worker URL: ${workerUrl}\n`);
    output.write(`- App URL: ${appUrl}\n`);
    output.write(`- Share URL: ${shareUrl}\n`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

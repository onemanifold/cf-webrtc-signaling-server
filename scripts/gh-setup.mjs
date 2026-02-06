#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = process.cwd();

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
  const name = `p2p-${ownerSlug}-${repoSlug}-${hash}`;
  return name.slice(0, 63);
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

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
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
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve({ out, err });
        return;
      }
      reject(new Error(err || `${command} ${args.join(" ")} failed with code ${code}`));
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

async function ensureEnvWithBranchPolicy(repo, envName, branch) {
  const body = JSON.stringify({
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  });

  await new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "--method", "PUT", `repos/${repo}/environments/${envName}`, "--input", "-"], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.stdin.write(body);
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`failed to configure environment ${envName}`));
    });
  });

  // Ensure branch policy contains the official branch.
  const policyPayload = JSON.stringify({ name: branch, type: "branch" });
  await new Promise((resolve, reject) => {
    const child = spawn(
      "gh",
      ["api", "--method", "POST", `repos/${repo}/environments/${envName}/deployment-branch-policies`, "--input", "-"],
      {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.write(policyPayload);
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const text = Buffer.concat(stderr).toString("utf8");
      if (text.includes("already exists")) {
        resolve();
        return;
      }
      reject(new Error(text || `failed to set branch policy for ${branch}`));
    });
  });
}

async function setSecretFromFile({ repo, envName, name, filePath }) {
  await new Promise((resolve, reject) => {
    const child = spawn("gh", ["secret", "set", name, "--repo", repo, "--env", envName], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["pipe", "inherit", "inherit"],
    });

    readFile(filePath)
      .then((buffer) => {
        child.stdin.write(buffer);
        child.stdin.end();
      })
      .catch(reject);

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`failed to set secret ${name}`));
    });
  });
}

async function setVariable({ repo, name, value, envName }) {
  const args = ["variable", "set", name, "--repo", repo, "--body", value];
  if (envName) {
    args.push("--env", envName);
  }
  await run("gh", args);
}

function pagesUrl(repo) {
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/`;
}

async function main() {
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

  const defaultRepo = currentRepo || `${ghUser}/${repoSlug}`;
  const defaultEnv = process.env.GH_DEPLOY_ENV || "production";
  const defaultBranch = "main";

  const rl = readline.createInterface({ input, output });

  try {
    output.write("\nGitHub bootstrap for Pages + Worker deployment\n\n");

    const targetRepo =
      (await rl.question(`Target repository [${defaultRepo}]: `)).trim() || defaultRepo;

    const shouldCreatePrivate = parseYesNo(
      (await rl.question("Create private repository if missing? (Y/n): ")).trim(),
      true,
    );

    const envName = defaultEnv;
    const officialBranch =
      (await rl.question(`Official deployment branch [${defaultBranch}]: `)).trim() || defaultBranch;

    const credentialsFileInput =
      (await rl.question("Credentials JSON path [credentials.json]: ")).trim() || "credentials.json";
    const credentialsFile = path.resolve(ROOT, credentialsFileInput);

    if (!(await fileExists(credentialsFile))) {
      throw new Error(`Credentials file not found: ${credentialsFile}`);
    }

    let credentials = {};
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
      output.write(`Created private repository and set push default to remote 'private'.\n`);
    }

    const derivedWorkerName = deriveWorkerName(targetRepo);
    const configuredWorkerName =
      credentials?.cloudflare && typeof credentials.cloudflare === "object" && credentials.cloudflare.workerName
        ? String(credentials.cloudflare.workerName)
        : derivedWorkerName;

    // Update local credentials file with derived workerName if missing.
    if (
      !(credentials?.cloudflare && typeof credentials.cloudflare === "object" && credentials.cloudflare.workerName)
    ) {
      credentials.cloudflare = {
        ...(credentials.cloudflare && typeof credentials.cloudflare === "object" ? credentials.cloudflare : {}),
        workerName: configuredWorkerName,
      };
      await writeFile(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      output.write(`Updated credentials file with workerName=${configuredWorkerName}.\n`);
    }

    await ensureEnvWithBranchPolicy(targetRepo, envName, officialBranch);
    output.write(`Configured environment '${envName}' with branch policy '${officialBranch}'.\n`);

    await setSecretFromFile({
      repo: targetRepo,
      envName,
      name: "CF_CREDENTIALS_JSON",
      filePath: credentialsFile,
    });
    output.write(`Set environment secret CF_CREDENTIALS_JSON on ${targetRepo}/${envName}.\n`);

    const workerUrl = `https://${configuredWorkerName}.workers.dev`;
    await setVariable({ repo: targetRepo, name: "P2P_WORKER_URL", value: workerUrl });
    await setVariable({ repo: targetRepo, name: "WORKER_NAME", value: configuredWorkerName });

    output.write(`Set repository variable P2P_WORKER_URL=${workerUrl}.\n`);

    const runWorkflowsNow = parseYesNo((await rl.question("Trigger deploy workflows now? (Y/n): ")).trim(), true);
    if (runWorkflowsNow) {
      await run("gh", ["workflow", "run", "deploy-worker.yml", "--repo", targetRepo]);
      await run("gh", ["workflow", "run", "pages.yml", "--repo", targetRepo]);
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

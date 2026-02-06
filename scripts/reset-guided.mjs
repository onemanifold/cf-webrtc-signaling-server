#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = process.cwd();
const WRANGLER_PATH = path.join(ROOT, "packages", "server", "wrangler.toml");
const CREDENTIALS_PATH = path.join(ROOT, "credentials.json");
const DEFAULT_GH_ENVIRONMENT = "production";
const RESETTABLE_TRACKED_FILES = ["packages/server/wrangler.toml", "package-lock.json"];
const RESETTABLE_ARTIFACT_PATHS = [path.join(ROOT, "apps", "p2p-test", "dist"), path.join(ROOT, ".wrangler")];
const GITHUB_BOOTSTRAP_SECRET = "CF_CREDENTIALS_JSON";
const GITHUB_BOOTSTRAP_VARIABLES = ["P2P_WORKER_URL", "WORKER_NAME"];

function parseCliArgs(argv) {
  const out = {
    help: false,
    nonInteractive: false,
    dryRun: false,
    localOnly: false,
    fullReset: false,
    undeployWorker: false,
    skipUndeployWorker: false,
    logoutWrangler: false,
    skipLogoutWrangler: false,
    teardownGithub: false,
    skipGithubTeardown: false,
    workerName: "",
    repo: "",
    environment: "",
    keepCredentials: false,
    keepTracked: false,
    keepArtifacts: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--non-interactive") {
      out.nonInteractive = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--local-only") {
      out.localOnly = true;
      continue;
    }
    if (arg === "--full-reset") {
      out.fullReset = true;
      continue;
    }

    if (arg === "--undeploy-worker") {
      out.undeployWorker = true;
      continue;
    }
    if (arg === "--skip-undeploy-worker") {
      out.skipUndeployWorker = true;
      continue;
    }
    if (arg === "--logout-wrangler") {
      out.logoutWrangler = true;
      continue;
    }
    if (arg === "--skip-logout-wrangler") {
      out.skipLogoutWrangler = true;
      continue;
    }
    if (arg === "--teardown-github") {
      out.teardownGithub = true;
      continue;
    }
    if (arg === "--skip-github-teardown") {
      out.skipGithubTeardown = true;
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
    if (arg === "--repo") {
      if (!next) {
        throw new Error("--repo expects owner/repo");
      }
      out.repo = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--environment") {
      if (!next) {
        throw new Error("--environment expects a value");
      }
      out.environment = next.trim();
      i += 1;
      continue;
    }

    if (arg === "--keep-credentials") {
      out.keepCredentials = true;
      continue;
    }
    if (arg === "--keep-tracked") {
      out.keepTracked = true;
      continue;
    }
    if (arg === "--keep-artifacts") {
      out.keepArtifacts = true;
      continue;
    }
  }

  return out;
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

async function chooseBoolean({ rl, prompt, defaultValue, nonInteractive }) {
  if (nonInteractive) {
    return defaultValue;
  }
  const suffix = defaultValue ? " (Y/n): " : " (y/N): ";
  const answer = await rl.question(`${prompt}${suffix}`);
  return parseYesNo(answer, defaultValue);
}

async function chooseText({ rl, prompt, defaultValue, nonInteractive }) {
  if (nonInteractive) {
    return defaultValue;
  }
  const renderedDefault = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${prompt}${renderedDefault}: `)).trim();
  return answer || defaultValue;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
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
      reject(new Error(err || out || `${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
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

async function resolveDefaultGithubRepo() {
  try {
    const { out } = await runCapture("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "-q",
      ".nameWithOwner",
    ]);
    if (out) {
      return out;
    }
  } catch {
    // fallback below
  }

  for (const remoteName of ["origin", "private", "upstream"]) {
    try {
      const { out } = await runCapture("git", ["remote", "get-url", remoteName]);
      const repo = parseGithubRepoFromRemoteUrl(out);
      if (repo) {
        return repo;
      }
    } catch {
      // continue
    }
  }

  return "";
}

async function readWorkerNameFromWrangler() {
  if (!(await fileExists(WRANGLER_PATH))) {
    return "";
  }
  const content = await readFile(WRANGLER_PATH, "utf8");
  const match = content.match(/^name\s*=\s*"([^"]+)"/m);
  return match ? match[1].trim() : "";
}

function isNotFoundLike(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("could not resolve to a repository") ||
    lower.includes("resource not accessible")
  );
}

async function runGitHubDelete({ endpoint, dryRun, label }) {
  if (dryRun) {
    output.write(`[dry-run] Would run: gh api --method DELETE ${endpoint}\n`);
    return "dry-run";
  }

  try {
    await runCapture("gh", ["api", "--method", "DELETE", endpoint, "--silent"]);
    output.write(`${label}: removed\n`);
    return "removed";
  } catch (error) {
    const message = formatErrorMessage(error);
    if (isNotFoundLike(message)) {
      output.write(`${label}: not found (already clean)\n`);
      return "not-found";
    }
    throw error;
  }
}

async function ensureGithubAccess({ shouldTeardownGithub, dryRun, targetRepo }) {
  if (!shouldTeardownGithub || dryRun) {
    return;
  }
  await runCapture("gh", ["--version"]);
  await runCapture("gh", ["auth", "status"]);
  await runCapture("gh", ["repo", "view", targetRepo, "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
}

async function readGithubVariableValue({ shouldTeardownGithub, dryRun, targetRepo, name }) {
  if (!shouldTeardownGithub || dryRun || !targetRepo) {
    return "";
  }
  try {
    const { out } = await runCapture("gh", [
      "variable",
      "get",
      name,
      "--repo",
      targetRepo,
      "--json",
      "value",
      "-q",
      ".value",
    ]);
    return out.trim();
  } catch (error) {
    const message = formatErrorMessage(error);
    if (isNotFoundLike(message)) {
      return "";
    }
    throw error;
  }
}

async function cleanupGithubBootstrap({ dryRun, shouldTeardownGithub, targetRepo, envName }) {
  if (!shouldTeardownGithub) {
    return "skipped";
  }

  const encodedEnv = encodeURIComponent(envName);
  const secretEndpoint = `repos/${targetRepo}/environments/${encodedEnv}/secrets/${GITHUB_BOOTSTRAP_SECRET}`;
  const secretResult = await runGitHubDelete({
    endpoint: secretEndpoint,
    dryRun,
    label: `GitHub env secret ${GITHUB_BOOTSTRAP_SECRET}`,
  });

  const variableResults = [];
  for (const varName of GITHUB_BOOTSTRAP_VARIABLES) {
    const encodedVar = encodeURIComponent(varName);
    const endpoint = `repos/${targetRepo}/actions/variables/${encodedVar}`;
    const result = await runGitHubDelete({
      endpoint,
      dryRun,
      label: `GitHub repo variable ${varName}`,
    });
    variableResults.push(`${varName}:${result}`);
  }

  const pagesResult = await runGitHubDelete({
    endpoint: `repos/${targetRepo}/pages`,
    dryRun,
    label: "GitHub Pages",
  });
  const environmentResult = await runGitHubDelete({
    endpoint: `repos/${targetRepo}/environments/${encodedEnv}`,
    dryRun,
    label: `GitHub environment ${envName}`,
  });

  return `secret:${secretResult}, vars:${variableResults.join("|")}, pages:${pagesResult}, env:${environmentResult}`;
}

async function undeployWorker({ dryRun, shouldUndeploy, workerName }) {
  if (!shouldUndeploy) {
    return "skipped";
  }
  if (!workerName) {
    throw new Error("Worker name is required for undeploy. Pass --worker-name or keep name in wrangler.toml.");
  }

  if (dryRun) {
    output.write(`[dry-run] Would run: npx wrangler delete ${workerName} --config ${WRANGLER_PATH} --force\n`);
    return "dry-run";
  }

  try {
    await runCapture("npx", ["wrangler", "delete", workerName, "--config", WRANGLER_PATH, "--force"]);
    output.write(`Deleted worker '${workerName}'.\n`);
    return "deleted";
  } catch (error) {
    const message = formatErrorMessage(error);
    if (isNotFoundLike(message)) {
      output.write(`Worker '${workerName}' not found (already clean).\n`);
      return "not-found";
    }
    throw error;
  }
}

async function logoutWrangler({ dryRun, shouldLogout }) {
  if (!shouldLogout) {
    return "skipped";
  }
  if (dryRun) {
    output.write("[dry-run] Would run: npx wrangler logout\n");
    return "dry-run";
  }
  await runCommand("npx", ["wrangler", "logout"], { cwd: ROOT });
  output.write("Wrangler OAuth session logged out.\n");
  return "logged-out";
}

async function cleanupCredentials({ dryRun, removeCredentials }) {
  if (!removeCredentials) {
    return "kept";
  }
  if (!(await fileExists(CREDENTIALS_PATH))) {
    return "not-found";
  }
  if (dryRun) {
    output.write(`[dry-run] Would remove ${CREDENTIALS_PATH}\n`);
    return "dry-run";
  }
  await rm(CREDENTIALS_PATH, { force: true });
  output.write(`Removed ${CREDENTIALS_PATH}\n`);
  return "removed";
}

async function cleanupTrackedFiles({ dryRun, restoreTracked }) {
  if (!restoreTracked) {
    return "kept";
  }
  if (dryRun) {
    output.write(`[dry-run] Would restore tracked files from HEAD: ${RESETTABLE_TRACKED_FILES.join(", ")}\n`);
    return "dry-run";
  }
  await runCommand("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...RESETTABLE_TRACKED_FILES], {
    cwd: ROOT,
  });
  output.write(`Restored tracked files: ${RESETTABLE_TRACKED_FILES.join(", ")}\n`);
  return "restored";
}

async function cleanupArtifacts({ dryRun, removeArtifacts }) {
  if (!removeArtifacts) {
    return "kept";
  }
  if (dryRun) {
    output.write(`[dry-run] Would remove local artifacts: ${RESETTABLE_ARTIFACT_PATHS.join(", ")}\n`);
    return "dry-run";
  }
  for (const itemPath of RESETTABLE_ARTIFACT_PATHS) {
    await rm(itemPath, { recursive: true, force: true });
  }
  output.write(`Removed local artifacts: ${RESETTABLE_ARTIFACT_PATHS.join(", ")}\n`);
  return "removed";
}

function printHelp() {
  output.write("Usage: node scripts/reset-guided.mjs [options]\n");
  output.write("Defaults: full stack teardown (GitHub + Cloudflare + local files)\n");
  output.write("Options:\n");
  output.write("  --dry-run                 Preview actions only\n");
  output.write("  --non-interactive         Use defaults without prompts\n");
  output.write("  --local-only              Skip all cloud/GitHub actions\n");
  output.write("  --full-reset              Force all cloud/GitHub teardown actions\n");
  output.write("  --undeploy-worker         Force worker undeploy\n");
  output.write("  --skip-undeploy-worker    Skip worker undeploy\n");
  output.write("  --logout-wrangler         Force Wrangler logout\n");
  output.write("  --skip-logout-wrangler    Skip Wrangler logout\n");
  output.write("  --teardown-github         Force GitHub teardown\n");
  output.write("  --skip-github-teardown    Skip GitHub teardown\n");
  output.write("  --repo <owner/repo>       GitHub repo for teardown\n");
  output.write(`  --environment <name>      GitHub environment (default: ${DEFAULT_GH_ENVIRONMENT})\n`);
  output.write("  --worker-name <name>      Worker name override for delete\n");
  output.write("  --keep-credentials        Keep credentials.json\n");
  output.write("  --keep-tracked            Keep tracked files unchanged\n");
  output.write("  --keep-artifacts          Keep local artifacts\n");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const rl = readline.createInterface({ input, output });

  try {
    const removeCredentials =
      !args.keepCredentials &&
      (await chooseBoolean({
        rl,
        prompt: "Remove local credentials.json?",
        defaultValue: true,
        nonInteractive: args.nonInteractive,
      }));

    const restoreTracked =
      !args.keepTracked &&
      (await chooseBoolean({
        rl,
        prompt: "Restore tracked workflow files (wrangler.toml + package-lock.json)?",
        defaultValue: true,
        nonInteractive: args.nonInteractive,
      }));

    const removeArtifacts =
      !args.keepArtifacts &&
      (await chooseBoolean({
        rl,
        prompt: "Remove local runtime/build artifacts (.wrangler + apps/p2p-test/dist)?",
        defaultValue: true,
        nonInteractive: args.nonInteractive,
      }));

    let shouldUndeploy = false;
    let shouldLogout = false;
    let shouldTeardownGithub = false;
    if (!args.localOnly) {
      const defaultCloudValue = true;
      const forceAll = args.fullReset;

      shouldUndeploy =
        !args.skipUndeployWorker &&
        (forceAll ||
          args.undeployWorker ||
          (await chooseBoolean({
            rl,
            prompt: "Undeploy Worker from Cloudflare?",
            defaultValue: defaultCloudValue,
            nonInteractive: args.nonInteractive,
          })));

      shouldTeardownGithub =
        !args.skipGithubTeardown &&
        (forceAll ||
          args.teardownGithub ||
          (await chooseBoolean({
            rl,
            prompt: "Teardown GitHub bootstrap state (Pages + env secret + repo vars + environment)?",
            defaultValue: defaultCloudValue,
            nonInteractive: args.nonInteractive,
          })));

      shouldLogout =
        !args.skipLogoutWrangler &&
        (forceAll ||
          args.logoutWrangler ||
          (await chooseBoolean({
            rl,
            prompt: "Log out Wrangler OAuth session?",
            defaultValue: defaultCloudValue,
            nonInteractive: args.nonInteractive,
          })));
    }

    let targetRepo = "";
    let envName = args.environment || DEFAULT_GH_ENVIRONMENT;
    if (shouldTeardownGithub) {
      const defaultRepo = args.repo || (await resolveDefaultGithubRepo());
      targetRepo = await chooseText({
        rl,
        prompt: "GitHub repo for teardown (owner/repo)",
        defaultValue: defaultRepo,
        nonInteractive: args.nonInteractive,
      });
      envName = await chooseText({
        rl,
        prompt: "GitHub environment name",
        defaultValue: envName,
        nonInteractive: args.nonInteractive,
      });
      if (!targetRepo) {
        if (args.dryRun) {
          output.write(
            "GitHub repo could not be inferred for dry-run. Pass --repo <owner/repo> to preview GitHub teardown.\n",
          );
          shouldTeardownGithub = false;
        } else {
          throw new Error("GitHub repo is required for teardown. Pass --repo <owner/repo>.");
        }
      }
    }

    await ensureGithubAccess({ shouldTeardownGithub, dryRun: args.dryRun, targetRepo });

    let workerName = args.workerName || (await readWorkerNameFromWrangler());
    if (!workerName) {
      workerName = await readGithubVariableValue({
        shouldTeardownGithub,
        dryRun: args.dryRun,
        targetRepo,
        name: "WORKER_NAME",
      });
    }
    if (shouldUndeploy && !workerName && !args.nonInteractive) {
      workerName = (await rl.question("Worker name to delete: ")).trim();
    }

    output.write("\nRunning reset actions...\n");

    const results = {
      credentials: "skipped",
      tracked: "skipped",
      artifacts: "skipped",
      github: "skipped",
      worker: "skipped",
      wrangler: "skipped",
    };
    const errors = [];

    try {
      results.github = await cleanupGithubBootstrap({
        dryRun: args.dryRun,
        shouldTeardownGithub,
        targetRepo,
        envName,
      });
    } catch (error) {
      results.github = "failed";
      errors.push(`github teardown: ${formatErrorMessage(error)}`);
    }

    try {
      results.worker = await undeployWorker({
        dryRun: args.dryRun,
        shouldUndeploy,
        workerName,
      });
    } catch (error) {
      results.worker = "failed";
      errors.push(`worker undeploy: ${formatErrorMessage(error)}`);
    }

    try {
      results.credentials = await cleanupCredentials({ dryRun: args.dryRun, removeCredentials });
    } catch (error) {
      results.credentials = "failed";
      errors.push(`credentials cleanup: ${formatErrorMessage(error)}`);
    }

    try {
      results.tracked = await cleanupTrackedFiles({ dryRun: args.dryRun, restoreTracked });
    } catch (error) {
      results.tracked = "failed";
      errors.push(`tracked files cleanup: ${formatErrorMessage(error)}`);
    }

    try {
      results.artifacts = await cleanupArtifacts({ dryRun: args.dryRun, removeArtifacts });
    } catch (error) {
      results.artifacts = "failed";
      errors.push(`artifact cleanup: ${formatErrorMessage(error)}`);
    }

    try {
      results.wrangler = await logoutWrangler({
        dryRun: args.dryRun,
        shouldLogout,
      });
    } catch (error) {
      results.wrangler = "failed";
      errors.push(`wrangler logout: ${formatErrorMessage(error)}`);
    }

    output.write("\nReset summary:\n");
    output.write(`- credentials.json: ${results.credentials}\n`);
    output.write(`- tracked files: ${results.tracked}\n`);
    output.write(`- artifacts: ${results.artifacts}\n`);
    output.write(`- github teardown: ${results.github}\n`);
    output.write(`- worker undeploy: ${results.worker}\n`);
    output.write(`- wrangler logout: ${results.wrangler}\n`);
    output.write("\nTip: run `git status --short` to confirm a clean working tree.\n");

    if (errors.length > 0) {
      throw new Error(`Reset completed with errors:\n- ${errors.join("\n- ")}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

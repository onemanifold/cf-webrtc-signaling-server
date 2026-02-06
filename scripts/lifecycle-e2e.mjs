#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const RESET_SCRIPT = path.join("scripts", "reset-guided.mjs");
const DEPLOY_SCRIPT = path.join("scripts", "deploy-guided.mjs");

function parseCliArgs(argv) {
  const out = {
    help: false,
    nonInteractive: false,
    skipReset: false,
    skipDeploy: false,
    resetDryRun: false,
    localOnlyReset: false,
    authMode: "",
    cfApiToken: "",
    workerName: "",
    repo: "",
    branch: "",
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
    if (arg === "--skip-reset") {
      out.skipReset = true;
      continue;
    }
    if (arg === "--skip-deploy") {
      out.skipDeploy = true;
      continue;
    }
    if (arg === "--reset-dry-run") {
      out.resetDryRun = true;
      continue;
    }
    if (arg === "--local-only-reset") {
      out.localOnlyReset = true;
      continue;
    }

    if (arg === "--auth-mode") {
      if (!next) {
        throw new Error("--auth-mode expects oauth or api");
      }
      out.authMode = next.trim().toLowerCase();
      i += 1;
      continue;
    }
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
  }

  return out;
}

function printHelp() {
  console.log("Usage: node scripts/lifecycle-e2e.mjs [options]");
  console.log("Runs reset + deploy in one command.");
  console.log("Options:");
  console.log("  --non-interactive      Pass non-interactive mode to reset/deploy");
  console.log("  --skip-reset           Skip reset phase");
  console.log("  --skip-deploy          Skip deploy phase");
  console.log("  --reset-dry-run        Run reset in dry-run mode (deploy is skipped)");
  console.log("  --local-only-reset     Reset local files only (no GitHub/Cloudflare teardown)");
  console.log("  --auth-mode <mode>     Deploy auth mode: oauth|api");
  console.log("  --cf-api-token <token> Cloudflare API token for deploy");
  console.log("  --worker-name <name>   Worker name for deploy");
  console.log("  --repo <owner/repo>    Target GitHub repo for deploy bootstrap");
  console.log("  --branch <name>        Official deployment branch");
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

function buildResetArgs(args) {
  const resetArgs = [RESET_SCRIPT];
  if (args.nonInteractive) {
    resetArgs.push("--non-interactive");
  }
  if (args.resetDryRun) {
    resetArgs.push("--dry-run");
  }
  if (args.localOnlyReset) {
    resetArgs.push("--local-only");
  }
  if (args.workerName) {
    resetArgs.push("--worker-name", args.workerName);
  }
  if (args.repo) {
    resetArgs.push("--repo", args.repo);
  }
  return resetArgs;
}

function buildDeployArgs(args) {
  const deployArgs = [DEPLOY_SCRIPT];
  if (args.nonInteractive) {
    deployArgs.push("--non-interactive");
  }
  if (args.authMode) {
    deployArgs.push("--auth-mode", args.authMode);
  }
  if (args.cfApiToken) {
    deployArgs.push("--cf-api-token", args.cfApiToken);
  }
  if (args.workerName) {
    deployArgs.push("--worker-name", args.workerName);
  }
  if (args.repo) {
    deployArgs.push("--repo", args.repo);
  }
  if (args.branch) {
    deployArgs.push("--branch", args.branch);
  }
  return deployArgs;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.resetDryRun) {
    args.skipDeploy = true;
  }

  console.log("Lifecycle pipeline: reset -> deploy");

  if (!args.skipReset) {
    const resetArgs = buildResetArgs(args);
    console.log(`\n[phase:reset] node ${resetArgs.join(" ")}`);
    await runCommand("node", resetArgs);
  } else {
    console.log("\n[phase:reset] skipped");
  }

  if (!args.skipDeploy) {
    const deployArgs = buildDeployArgs(args);
    console.log(`\n[phase:deploy] node ${deployArgs.join(" ")}`);
    await runCommand("node", deployArgs);
  } else {
    console.log("\n[phase:deploy] skipped");
  }

  console.log("\nLifecycle command completed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

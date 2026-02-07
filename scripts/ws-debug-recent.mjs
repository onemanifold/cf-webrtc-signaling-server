#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";

const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {
    credentialsFile: "credentials.json",
    roomId: "",
    limit: "80",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--credentials-file" && next) {
      out.credentialsFile = next;
      i += 1;
      continue;
    }
    if (arg === "--room" && next) {
      out.roomId = next;
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      out.limit = next;
      i += 1;
      continue;
    }
  }
  return out;
}

function workerUrlFromCredentials(credentials) {
  const workerName = credentials?.cloudflare?.workerName;
  const subdomain = credentials?.cloudflare?.subdomain;
  if (!workerName || !subdomain) {
    throw new Error("Missing cloudflare.workerName/subdomain in credentials.");
  }
  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(ROOT, args.credentialsFile);
  const raw = await readFile(filePath, "utf8");
  const credentials = JSON.parse(raw);

  const workerUrl = workerUrlFromCredentials(credentials);
  const secret = credentials?.secrets?.INTERNAL_API_SECRET || credentials?.secrets?.DEV_ISSUER_SECRET;
  if (!secret) {
    throw new Error("Missing INTERNAL_API_SECRET (or DEV_ISSUER_SECRET) in credentials.");
  }

  const query = new URLSearchParams();
  if (args.roomId) {
    query.set("roomId", args.roomId);
  }
  query.set("limit", args.limit);
  const url = `${workerUrl}/debug/ws-recent?${query.toString()}`;

  const response = await fetch(url, {
    headers: {
      "x-internal-secret": secret,
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`debug endpoint failed (${response.status}): ${body}`);
  }
  const parsed = JSON.parse(body);
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});


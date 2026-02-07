#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";

const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {
    credentialsFile: "credentials.json",
    roomId: "",
    limit: "200",
    intervalMs: 2000,
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
    if (arg === "--interval-ms" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.intervalMs = Math.floor(parsed);
      }
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

function browserLabel(ua) {
  if (!ua) {
    return "OT";
  }
  if (ua.includes("Firefox")) {
    return "FF";
  }
  if (ua.includes("Chrome")) {
    return "CH";
  }
  if (ua.includes("Node")) {
    return "ND";
  }
  return "OT";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const seen = new Set();
  const search = new URLSearchParams();
  if (args.roomId) {
    search.set("roomId", args.roomId);
  }
  search.set("limit", args.limit);
  const endpoint = `${workerUrl}/debug/ws-recent?${search.toString()}`;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          "x-internal-secret": secret,
        },
      });
      const body = await response.text();
      if (!response.ok) {
        console.log(`${new Date().toISOString()} ERR status=${response.status} body=${body.slice(0, 180)}`);
        await sleep(args.intervalMs);
        continue;
      }
      const parsed = JSON.parse(body);
      const events = Array.isArray(parsed.events) ? parsed.events : [];
      for (const event of events) {
        const key = `${event.ts}:${event.phase}:${event.cfRay ?? ""}:${event.trace ?? ""}:${event.status ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        console.log(
          [
            new Date(event.ts).toISOString(),
            browserLabel(event.ua),
            `room=${event.roomId ?? "-"}`,
            `trace=${event.trace ?? "-"}`,
            `phase=${event.phase ?? "-"}`,
            `detail=${event.detail ?? "-"}`,
            `status=${event.status ?? "-"}`,
            `upgrade=${event.upgrade ?? "-"}`,
            `proto=${event.httpProtocol ?? "-"}`,
          ].join(" "),
        );
      }
    } catch (error) {
      console.log(`${new Date().toISOString()} ERR ${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(args.intervalMs);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

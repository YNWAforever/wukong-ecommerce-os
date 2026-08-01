import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageRunners, shouldTryNextRunner } from "./runtime-doctor.mjs";

const root = new URL("../", import.meta.url);

export function compareSecretNames(requiredNames, configuredNames) {
  const required = [...new Set(requiredNames)].sort();
  const configured = [...new Set(configuredNames)].sort();
  return {
    missing: required.filter((name) => !configured.includes(name)),
    unexpected: configured.filter((name) => !required.includes(name)),
  };
}

export function parseSecretNames(json) {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("invalid Wrangler secret list");
  return parsed.map((entry) => {
    if (!entry || typeof entry.name !== "string" || !entry.name) {
      throw new Error("invalid Wrangler secret entry");
    }
    return entry.name;
  });
}

/**
 * A Worker that does not exist yet cannot hold secrets, and `wrangler deploy` is
 * about to create it — so blocking here makes a first deploy impossible. Any
 * other failure still aborts.
 */
export function classifyPreflight(result) {
  if (result.status === 0) return { allow: true };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/Worker .*not found/i.test(output)) {
    return {
      allow: true,
      warning:
        "Worker does not exist yet; deploying to create it. Set the required secrets and redeploy before this environment is usable.",
    };
  }
  return { allow: false };
}

export function verifyExactSecretNames(requiredNames, configuredNames) {
  const result = compareSecretNames(requiredNames, configuredNames);
  if (result.missing.length || result.unexpected.length) {
    const missing = result.missing.length ? result.missing.join(", ") : "none";
    const unexpected = result.unexpected.length
      ? result.unexpected.join(", ")
      : "none";
    throw new Error(
      `Worker secret preflight failed; missing: ${missing}; unexpected: ${unexpected}`,
    );
  }
}

function main() {
  const environment = process.argv[2]?.trim();
  if (!environment)
    throw new Error("deployment environment argument is required");
  const source = JSON.parse(
    readFileSync(new URL("cloudflare-runtime.config.json", root), "utf8"),
  );
  const selected = source.environments[environment];
  if (!selected) throw new Error("unsupported CLOUDFLARE_ENV");

  // corepack is not installed everywhere pnpm is. Hardcoding it made this
  // preflight abort with an empty ENOENT result, which reads identically to a
  // genuine wrangler failure and blocked the deploy for the wrong reason.
  const args = [
    "--filter",
    "@wukong/worker",
    "exec",
    "wrangler",
    "secret",
    "list",
    "--name",
    selected.worker,
    "--format",
    "json",
  ];
  let result;
  for (const runner of packageRunners()) {
    result = spawnSync(runner.command, [...runner.lead, ...args], {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      windowsHide: true,
    });
    if (!shouldTryNextRunner(result.error)) break;
  }
  const decision = classifyPreflight(result);
  if (!decision.allow) {
    throw new Error("Wrangler secret list failed; deployment aborted");
  }
  if (decision.warning) {
    process.stderr.write(`${decision.warning}\n`);
    return;
  }
  verifyExactSecretNames(
    source.requiredSecrets,
    parseSecretNames(result.stdout),
  );
  process.stdout.write(
    `Worker secret preflight passed for ${selected.worker}: ${source.requiredSecrets.length} exact names\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryPoint) main();

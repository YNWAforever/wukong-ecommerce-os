import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

  const executable = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const result = spawnSync(
    executable,
    [
      "pnpm",
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
    ],
    {
      cwd: fileURLToPath(root),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error("Wrangler secret list failed; deployment aborted");
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

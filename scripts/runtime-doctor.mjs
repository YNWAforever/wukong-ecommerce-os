import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STATUS_LABEL = {
  ok: "OK   ",
  failed: "FAIL ",
  blocked: "BLOCK",
  unknown: "?????",
};

/**
 * A check whose dependency did not pass is `blocked`, never `failed`. Reporting
 * it as a second failure sends the operator fixing two things when one is
 * broken. `unknown` is likewise distinct from `failed`: an unauthenticated
 * wrangler must not render as "your queues are missing".
 */
export function resolveStatuses(checks) {
  const byId = new Map();
  const resolved = [];
  for (const check of checks) {
    let entry;
    if (check.dependsOn) {
      const dependency = byId.get(check.dependsOn);
      if (!dependency) {
        // The dependency id was never resolved before this point — either it
        // is a typo that appears nowhere in `checks`, or it names a check
        // that comes later in the array. Either way we genuinely do not know
        // its status, so this must never fall through to the check's own
        // (possibly "ok") status.
        entry = {
          ...check,
          status: "unknown",
          detail: `dependsOn references unresolved check id "${check.dependsOn}"`,
        };
      } else if (dependency.status !== "ok") {
        entry = {
          ...check,
          status: "blocked",
          detail: `blocked by ${check.dependsOn}`,
          fix: dependency.fix,
        };
      } else {
        entry = { ...check, status: check.status ?? "unknown" };
      }
    } else {
      entry = { ...check, status: check.status ?? "unknown" };
    }
    byId.set(entry.id, entry);
    resolved.push(entry);
  }
  return resolved;
}

export function formatReport(checks) {
  const lines = [];
  for (const check of resolveStatuses(checks)) {
    lines.push(`${STATUS_LABEL[check.status]} ${check.id} — ${check.detail}`);
    if (check.status !== "ok" && check.fix)
      lines.push(`      fix: ${check.fix}`);
  }
  return lines.join("\n");
}

export function hasFailure(checks) {
  return resolveStatuses(checks).some((check) => check.status !== "ok");
}

export function expectedQueueNames(config, environment) {
  const selected = config.environments?.[environment];
  if (!selected) throw new Error(`unsupported environment: ${environment}`);
  return [
    selected.listingQueue,
    selected.listingDlq,
    selected.shoplineQueue,
    selected.shoplineDlq,
  ];
}

function parseNames(json, key) {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
  return parsed.map((entry) => entry?.[key]).filter(Boolean);
}

export function checkQueues(expected, listJson, environment) {
  let present;
  try {
    present = parseNames(listJson, "queue_name");
  } catch {
    return {
      id: "queues",
      status: "unknown",
      detail: "could not read `wrangler queues list --json`",
      fix: "wrangler queues list --json",
    };
  }
  const missing = expected.filter((name) => !present.includes(name));
  if (missing.length === 0) {
    return {
      id: "queues",
      status: "ok",
      detail: `${expected.length} queues present`,
    };
  }
  return {
    id: "queues",
    status: "failed",
    detail: `missing ${missing.join(", ")}`,
    fix: `pnpm runtime:provision ${environment}`,
  };
}

export function checkHyperdrive(listJson, configuredId) {
  let ids;
  try {
    ids = parseNames(listJson, "id");
  } catch {
    return {
      id: "hyperdrive",
      status: "unknown",
      detail: "could not read `wrangler hyperdrive list --json`",
      fix: "wrangler hyperdrive list --json",
    };
  }
  if (!configuredId) {
    return {
      id: "hyperdrive",
      status: "failed",
      detail: "CLOUDFLARE_HYPERDRIVE_ID is unset",
      fix: "wrangler hyperdrive create wukong --connection-string <neon-url>",
    };
  }
  if (!ids.includes(configuredId)) {
    return {
      id: "hyperdrive",
      status: "failed",
      detail: "no Hyperdrive config matches CLOUDFLARE_HYPERDRIVE_ID",
      fix: "wrangler hyperdrive list --json",
    };
  }
  return { id: "hyperdrive", status: "ok", detail: "configured id exists" };
}

export function checkHealthGet(body) {
  const bindings = body?.bindings ?? {};
  const unresolved = Object.entries(bindings)
    .filter(([, resolved]) => !resolved)
    .map(([name]) => name);
  if (unresolved.length) {
    return {
      id: "health-get",
      status: "failed",
      detail: `unresolved bindings: ${unresolved.join(", ")}`,
      fix: "pnpm --filter @wukong/worker deploy:production",
      dependsOn: "worker-secrets",
    };
  }
  return {
    id: "health-get",
    status: "ok",
    detail: `deployed, build ${body.buildSha}`,
    dependsOn: "worker-secrets",
  };
}

export function checkHealthSigned(result) {
  if (result.error) {
    return {
      id: "health-signed",
      status: "unknown",
      detail: `worker unreachable: ${result.error}`,
      fix: "check QUEUE_INGRESS_URL in Vercel",
      dependsOn: "health-get",
    };
  }
  if (result.status === 401) {
    return {
      id: "health-signed",
      status: "failed",
      // The defining failure: both sides look configured, neither agrees.
      // A stale clock past verifyQueueRequest's +-300s window produces the
      // same 401 and is worth ruling out before rotating the secret.
      detail:
        "Vercel's QUEUE_INGRESS_SECRET does not match the Worker's (or the two clocks have drifted more than 300s)",
      fix: "wrangler secret put QUEUE_INGRESS_SECRET  # must equal the Vercel value; if both sides already match, check for clock skew",
      dependsOn: "health-get",
    };
  }
  if (result.status !== 200) {
    return {
      id: "health-signed",
      status: "unknown",
      detail: `unexpected status ${result.status}`,
      fix: "check the worker deployment logs",
      dependsOn: "health-get",
    };
  }
  if (!result.body?.checks?.hyperdriveConnects) {
    return {
      id: "health-signed",
      status: "failed",
      detail:
        "secret matches, but the database did not answer through Hyperdrive",
      fix: "wrangler hyperdrive list --json  # confirm the connection string",
      dependsOn: "health-get",
    };
  }
  return {
    id: "health-signed",
    status: "ok",
    detail: "secret agrees and the database answers",
    dependsOn: "health-get",
  };
}

/**
 * Mirrors signQueueRequest in packages/jobs/src/cloudflare-queue.ts, which is
 * the source of truth. Duplicated deliberately so the doctor has no build
 * dependency — it must run when the workspace build is broken, which is exactly
 * when you reach for it. The test vector fails loudly if the two diverge.
 */
export function signHealthProbe({ secret, timestamp, path, body }) {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${path}\n${body}`)
    .digest("base64url");
}

/**
 * wrangler is a devDependency of apps/worker only; this workspace declares no
 * hoist pattern, so a bare `spawnSync("wrangler", ...)` from the repo root
 * finds nothing on PATH. Run it the same way verify-cloudflare-secrets.mjs
 * does — through the workspace that actually depends on it — so this check
 * is PATH-independent.
 */
function wrangler(args) {
  const executable = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const result = spawnSync(
    executable,
    ["pnpm", "--filter", "@wukong/worker", "exec", "wrangler", ...args],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    error: result.error,
  };
}

async function probeSigned(url, secret) {
  const body = "{}";
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = signHealthProbe({
    secret,
    timestamp,
    path: "/health",
    body,
  });
  try {
    const response = await fetch(new URL("/health", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wukong-timestamp": String(timestamp),
        "x-wukong-signature": signature,
      },
      body,
    });
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function whoamiCheck() {
  const result = wrangler(["whoami"]);
  const output = result.stdout;
  // The two "we don't know" cases are honestly distinct: wrangler never ran
  // (a toolchain problem "wrangler login" cannot fix), versus wrangler ran
  // and told us plainly that no account is authenticated.
  if (result.error || (result.status !== 0 && !output.trim())) {
    const reason = result.error
      ? result.error.message
      : (result.stderr ?? "").trim() || `exit code ${result.status}`;
    return {
      status: "unknown",
      detail: `wrangler could not be run: ${reason}`,
      fix: "pnpm install --filter @wukong/worker to repair the worker toolchain, then re-run this check",
    };
  }
  return output.includes("@") || /account/i.test(output)
    ? { status: "ok", detail: "wrangler authenticated" }
    : {
        status: "unknown",
        detail: "wrangler is not logged in",
        fix: "wrangler login",
      };
}

function secretsCheck(config) {
  const required = config.requiredSecrets ?? [];
  let configured = [];
  try {
    configured = JSON.parse(wrangler(["secret", "list"]).stdout).map(
      (entry) => entry.name,
    );
  } catch {
    return {
      id: "worker-secrets",
      status: "unknown",
      detail: "could not list worker secrets",
      fix: "wrangler secret list",
      dependsOn: "wrangler-auth",
    };
  }
  const missing = required.filter((name) => !configured.includes(name));
  return missing.length
    ? {
        id: "worker-secrets",
        status: "failed",
        detail: `missing ${missing.join(", ")}`,
        fix: `wrangler secret put ${missing[0]}`,
        dependsOn: "wrangler-auth",
      }
    : {
        id: "worker-secrets",
        status: "ok",
        detail: `${required.length} secrets set`,
        dependsOn: "wrangler-auth",
      };
}

export function vercelEnvCheck(url, secret, environment) {
  const missing = [
    ...(url ? [] : ["QUEUE_INGRESS_URL"]),
    ...(secret ? [] : ["QUEUE_INGRESS_SECRET"]),
  ];
  return missing.length
    ? {
        status: "failed",
        detail: `missing ${missing.join(", ")} in this environment`,
        fix: `vercel env add ${missing[0]} ${environment}`,
      }
    : { status: "ok", detail: "ingress url and secret present" };
}

async function main() {
  const environment = process.argv[2]?.trim();
  if (!environment) throw new Error("usage: runtime:doctor <environment>");
  const preDeployOnly = process.argv.includes("--pre-deploy");
  const config = JSON.parse(
    readFileSync(
      new URL("../cloudflare-runtime.config.json", import.meta.url),
      "utf8",
    ),
  );
  const ingressUrl = process.env.QUEUE_INGRESS_URL?.trim();
  const ingressSecret = process.env.QUEUE_INGRESS_SECRET?.trim();

  const checks = [
    { id: "wrangler-auth", ...whoamiCheck() },
    checkQueues(
      expectedQueueNames(config, environment),
      wrangler(["queues", "list", "--json"]).stdout,
      environment,
    ),
    checkHyperdrive(
      wrangler(["hyperdrive", "list", "--json"]).stdout,
      process.env.CLOUDFLARE_HYPERDRIVE_ID ?? "",
    ),
    secretsCheck(config),
  ];

  if (!preDeployOnly) {
    checks.push({
      id: "vercel-env",
      ...vercelEnvCheck(ingressUrl, ingressSecret, environment),
    });
    if (ingressUrl) {
      const health = await fetch(new URL("/health", ingressUrl)).then(
        (response) => response.json(),
        () => null,
      );
      checks.push(
        health
          ? checkHealthGet(health)
          : {
              id: "health-get",
              status: "unknown",
              detail: "worker unreachable",
              fix: "check QUEUE_INGRESS_URL",
              dependsOn: "worker-secrets",
            },
      );
      if (ingressSecret)
        checks.push(
          checkHealthSigned(await probeSigned(ingressUrl, ingressSecret)),
        );
    }
  }

  console.log(formatReport(checks));
  console.log(
    "\nnote: SHOPLINE_TOKEN_ENCRYPTION_KEY and the two shopline queues are required by the\n" +
      "preflight but inert under CSV-only operation; a generated placeholder is correct.",
  );
  if (hasFailure(checks)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("runtime-doctor.mjs")) await main();

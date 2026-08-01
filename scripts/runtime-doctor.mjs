import { createHmac } from "node:crypto";

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
    const dependency = check.dependsOn ? byId.get(check.dependsOn) : undefined;
    const blocked = dependency && dependency.status !== "ok";
    const entry = blocked
      ? {
          ...check,
          status: "blocked",
          detail: `blocked by ${check.dependsOn}`,
          fix: dependency.fix,
        }
      : { ...check, status: check.status ?? "unknown" };
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
      detail: "Vercel's QUEUE_INGRESS_SECRET does not match the Worker's",
      fix: "wrangler secret put QUEUE_INGRESS_SECRET  # must equal the Vercel value",
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

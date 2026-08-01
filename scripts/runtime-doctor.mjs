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

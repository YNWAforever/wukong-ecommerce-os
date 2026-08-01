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

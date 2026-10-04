import { paidListingReservation, type WorkspaceProfile } from "@wukong/core";
import type { WorkspaceRepositories } from "@wukong/db";
export type WorkspaceReadinessItem = {
  key: "ai" | "queue" | "storage" | "shopline" | "reviewer";
  state: "ready" | "blocked" | "unknown";
  checkedAt: string | null;
  safeReason: string;
  nextAction: string;
};
type Observations = Awaited<
  ReturnType<WorkspaceRepositories["workspaces"]["readinessObservations"]>
>;
export type ReadinessEnvironment = {
  AI_PROVIDER?: string;
  LISTING_PAID_OPERATIONS_ENABLED?: string;
};
export function summarizeWorkspaceReadiness({
  profile,
  observations,
  env,
  now,
}: {
  profile: WorkspaceProfile;
  observations: Observations | null;
  env: ReadinessEnvironment;
  now: Date;
}): WorkspaceReadinessItem[] {
  const item = (
    key: WorkspaceReadinessItem["key"],
    state: WorkspaceReadinessItem["state"],
    checkedAt: Date | null,
    safeReason: string,
    nextAction: string,
  ): WorkspaceReadinessItem => ({
    key,
    state,
    checkedAt: checkedAt?.toISOString() ?? null,
    safeReason,
    nextAction,
  });
  const recent = (date: Date) =>
    Number.isFinite(date.getTime()) &&
    date.getTime() <= now.getTime() &&
    now.getTime() - date.getTime() <= 15 * 60_000;
  if (!observations)
    return (["ai", "queue", "storage", "shopline", "reviewer"] as const).map(
      (key) =>
        item(
          key,
          "unknown",
          null,
          "Workspace observations are unavailable.",
          "Reload or ask support to check the deployment.",
        ),
    );
  const provider = env.AI_PROVIDER ?? "openai";
  let ai: WorkspaceReadinessItem;
  let admitted = false;
  try {
    const policy = profile.listingAi;
    admitted = Boolean(
      env.LISTING_PAID_OPERATIONS_ENABLED === "true" &&
      policy &&
      policy.provider === provider &&
      Number(policy.budgetCapUsd) > 0 &&
      Number(policy.runCeilingUsd) >= Number(paidListingReservation(policy)),
    );
  } catch {
    admitted = false;
  }
  const observedAi = observations.latestAi;
  if (provider === "fake")
    ai = item(
      "ai",
      "unknown",
      null,
      "Synthetic AI adapter selected; live provider is unverified.",
      "Use an authorized acceptance run before enabling paid AI.",
    );
  else if (!admitted)
    ai = item(
      "ai",
      "blocked",
      now,
      "Paid AI admission is disabled or its workspace policy is incomplete.",
      "Complete model and budget policy through the approved setup.",
    );
  else if (
    observedAi &&
    observedAi.provider === provider &&
    observedAi.model === profile.listingAi?.model &&
    recent(observedAi.checkedAt) &&
    ["succeeded", "failed"].includes(observedAi.status)
  )
    ai = item(
      "ai",
      observedAi.status === "succeeded" ? "ready" : "blocked",
      observedAi.checkedAt,
      observedAi.status === "succeeded"
        ? "A recent recorded invocation of this configured model succeeded; no new probe was sent."
        : "The latest recent recorded invocation of this configured model failed.",
      observedAi.status === "succeeded"
        ? "Review normal work results; this observation expires after 15 minutes."
        : "Inspect the safe request ID in Jobs before retrying.",
    );
  else
    ai = item(
      "ai",
      "unknown",
      observedAi?.checkedAt ?? null,
      "No recent successful observation of the configured model is available.",
      "Use an authorized acceptance run; this page does not send paid probes.",
    );
  const step = observations.latestQueueStep;
  const queue =
    step && step.state === "completed" && recent(step.checkedAt)
      ? item(
          "queue",
          "ready",
          step.checkedAt,
          "A workspace worker step completed within the last 15 minutes.",
          "Check Jobs for the progress of your own work; this is a recent observation.",
        )
      : item(
          "queue",
          "unknown",
          step?.checkedAt ?? null,
          "No recent completed worker step proves queue processing here.",
          "Check Jobs or ask support to verify the worker and queue.",
        );
  return [
    ai,
    queue,
    item(
      "storage",
      "unknown",
      null,
      "No safe current object-storage health observation is available.",
      "Ask support to verify an authorized upload and download; no storage probe runs here.",
    ),
    observations.connectionPresent
      ? item(
          "shopline",
          "unknown",
          now,
          "A stored connection exists. Token validity and worker publishing authorization are unverified.",
          "Review the connection and complete the separately authorized merchant acceptance gate.",
        )
      : item(
          "shopline",
          "blocked",
          now,
          "No SHOPLINE connection is stored for this workspace.",
          "An administrator can configure the connection; publishing needs separate authorization.",
        ),
    observations.reviewerCount > 0
      ? item(
          "reviewer",
          "ready",
          now,
          "An active reviewer-capable workspace member exists.",
          "Assign review to an active reviewer or administrator.",
        )
      : item(
          "reviewer",
          "blocked",
          now,
          "No active reviewer-capable workspace member exists.",
          "An administrator must add an active reviewer before approval.",
        ),
  ];
}

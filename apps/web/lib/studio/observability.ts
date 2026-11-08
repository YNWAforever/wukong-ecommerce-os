/**
 * Content-free Studio observability (roadmap P0/A5).
 *
 * Turns already persist their trace, run row, audit events and budget
 * reservation; those are the durable record. This module adds the operational
 * signal an operator/dashboard needs without duplicating any of that durable
 * data: one structured line per turn (duration, bounded-step counters, status,
 * settled cost) and a budget-threshold alert.
 *
 * Rules:
 *  - never log prompts, model output, questions, customer content, tokens or
 *    URLs; only fixed counters, status codes and USD strings;
 *  - metrics must never change a turn's outcome, so callers wrap emission in a
 *    best-effort guard and this module only writes to the logger;
 *  - the budget cap is the workspace's committed-USD cap enforced at admission
 *    (`monthlyBudgetUsd` is the current cap; it does not auto-reset). Alerting
 *    is therefore about utilisation of that cap, not a calendar month.
 */

export type StudioTurnMetricEvent = {
  event: "studio.turn.metrics";
  /** Reply status (`answered`, `partial`, `needs_input`) or `failed`. */
  status: string;
  durationMs: number;
  toolSteps: number;
  detailReads: number;
  modelCalls: number;
  traceSteps: number;
  outputCount: number;
  limitationCount: number;
  /** Actual settled model cost for this turn, or null when no model ran. */
  settledUsd: string | null;
  /** Safe failure code (`studio_turn_timeout`, ...), only on failed turns. */
  errorCode?: string;
};

export type StudioBudgetAlertLevel = "warning" | "exhausted";

export type StudioBudgetAlertEvent = {
  event: "studio.budget.alert";
  level: StudioBudgetAlertLevel;
  scope: "workspace";
  committedUsd: string;
  budgetUsd: string;
  utilizationPercent: number;
};

export type TurnMetricInput = {
  status: string;
  durationMs: number;
  toolSteps: number;
  detailReads: number;
  modelCalls: number;
  traceSteps: number;
  outputCount: number;
  limitationCount: number;
  settledUsd: string | null;
  errorCode?: string;
};

/** Warning at 80% of the cap, alert at 100%. */
const WARNING_RATIO = 0.8;

function decimal(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function turnMetricEvent(input: TurnMetricInput): StudioTurnMetricEvent {
  const whole = (value: number): number =>
    Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return {
    event: "studio.turn.metrics",
    status: input.status,
    durationMs: whole(input.durationMs),
    toolSteps: whole(input.toolSteps),
    detailReads: whole(input.detailReads),
    modelCalls: whole(input.modelCalls),
    traceSteps: whole(input.traceSteps),
    outputCount: whole(input.outputCount),
    limitationCount: whole(input.limitationCount),
    settledUsd: input.settledUsd,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

export function budgetAlertLevel(
  committedUsd: string,
  budgetUsd: string | null,
): StudioBudgetAlertLevel | null {
  if (!budgetUsd) return null;
  const committed = decimal(committedUsd);
  const budget = decimal(budgetUsd);
  if (committed === null || budget === null) return null;
  if (budget <= 0) return committed > 0 ? "exhausted" : "warning";
  const ratio = committed / budget;
  if (ratio >= 1) return "exhausted";
  if (ratio >= WARNING_RATIO) return "warning";
  return null;
}

export function budgetAlertEvent(input: {
  committedUsd: string;
  budgetUsd: string;
  level: StudioBudgetAlertLevel;
}): StudioBudgetAlertEvent {
  const committed = decimal(input.committedUsd) ?? 0;
  const budget = decimal(input.budgetUsd) ?? 0;
  return {
    event: "studio.budget.alert",
    level: input.level,
    scope: "workspace",
    committedUsd: input.committedUsd,
    budgetUsd: input.budgetUsd,
    utilizationPercent:
      budget > 0 ? Math.round((committed / budget) * 100) : 100,
  };
}

/** Single-line structured log, matching the repository's logging convention. */
export function emitStudioEvent(
  event: StudioTurnMetricEvent | StudioBudgetAlertEvent,
): void {
  console.info(JSON.stringify(event));
}

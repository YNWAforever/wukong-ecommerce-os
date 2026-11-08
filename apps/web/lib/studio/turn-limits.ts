/**
 * Hard per-turn budgets for the Conversation Studio (plan Task 14, spec 3.2).
 *
 * The spec bounds a turn to a 45 s deadline and at most six tool steps, with a
 * separate bounded fan-out for per-listing detail reads (a workspace-wide gap
 * review legitimately reads more than six listings). Detail reads cannot grow
 * without bound either, so they have their own cap. A turn that exceeds either
 * limit is persisted as a failed run with a distinct error code; it never
 * degrades into an unlabelled partial success.
 */

export const STUDIO_TURN_DEADLINE_MS = 45_000;
/** First-class tool calls: search, workspace quality, jobs, etc. */
export const STUDIO_MAX_TOOL_STEPS = 6;
/** Per-listing detail reads (catalog.get), bounded separately. */
export const STUDIO_MAX_DETAIL_READS = 20;
/** At most two model calls per turn (planner/analysis or proposer). */
export const STUDIO_MAX_MODEL_CALLS = 2;

export class StudioTurnDeadlineError extends Error {
  readonly code = "studio_turn_timeout";
  constructor() {
    super("studio turn deadline exceeded");
    this.name = "StudioTurnDeadlineError";
  }
}

export class StudioTurnStepBudgetError extends Error {
  readonly code = "studio_step_budget_exceeded";
  constructor(readonly limit: "tool_steps" | "detail_reads" | "model_calls") {
    super(`studio turn ${limit} budget exceeded`);
    this.name = "StudioTurnStepBudgetError";
  }
}

export type StudioTurnLimits = {
  readonly deadlineAt: number;
  readonly toolSteps: number;
  readonly detailReads: number;
  readonly modelCalls: number;
  /** Throws when the wall-clock deadline has been reached. */
  assertActive(): void;
  /** Counts one tool call and asserts both budgets and the deadline. */
  beginTool(toolId: string): void;
  /** Counts one model call and asserts its budget and the deadline. */
  beginModel(): void;
};

export type StudioTurnLimitOptions = {
  now?: () => number;
  deadlineMs?: number;
  maxToolSteps?: number;
  maxDetailReads?: number;
  maxModelCalls?: number;
};

export function createStudioTurnLimits(
  options: StudioTurnLimitOptions = {},
): StudioTurnLimits {
  const now = options.now ?? (() => Date.now());
  const deadlineMs = options.deadlineMs ?? STUDIO_TURN_DEADLINE_MS;
  const maxToolSteps = options.maxToolSteps ?? STUDIO_MAX_TOOL_STEPS;
  const maxDetailReads = options.maxDetailReads ?? STUDIO_MAX_DETAIL_READS;
  const maxModelCalls = options.maxModelCalls ?? STUDIO_MAX_MODEL_CALLS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new TypeError("invalid studio turn deadline");
  for (const limit of [maxToolSteps, maxDetailReads, maxModelCalls])
    if (!Number.isInteger(limit) || limit < 1)
      throw new TypeError("invalid studio turn step budget");
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  let toolSteps = 0;
  let detailReads = 0;
  let modelCalls = 0;
  return {
    deadlineAt,
    get toolSteps() {
      return toolSteps;
    },
    get detailReads() {
      return detailReads;
    },
    get modelCalls() {
      return modelCalls;
    },
    assertActive() {
      if (now() >= deadlineAt) throw new StudioTurnDeadlineError();
    },
    beginTool(toolId) {
      this.assertActive();
      if (toolId === "catalog.get") {
        detailReads += 1;
        if (detailReads > maxDetailReads)
          throw new StudioTurnStepBudgetError("detail_reads");
      } else {
        toolSteps += 1;
        if (toolSteps > maxToolSteps)
          throw new StudioTurnStepBudgetError("tool_steps");
      }
      this.assertActive();
    },
    beginModel() {
      this.assertActive();
      modelCalls += 1;
      if (modelCalls > maxModelCalls)
        throw new StudioTurnStepBudgetError("model_calls");
      this.assertActive();
    },
  };
}

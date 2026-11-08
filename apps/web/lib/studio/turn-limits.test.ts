import { describe, expect, it } from "vitest";

import {
  createStudioTurnLimits,
  STUDIO_MAX_DETAIL_READS,
  STUDIO_MAX_MODEL_CALLS,
  STUDIO_MAX_TOOL_STEPS,
  STUDIO_TURN_DEADLINE_MS,
  StudioTurnDeadlineError,
  StudioTurnStepBudgetError,
} from "./turn-limits.js";

describe("studio turn limits", () => {
  it("counts first-class tool steps separately from per-listing detail reads", () => {
    const limits = createStudioTurnLimits({ maxToolSteps: 2, maxDetailReads: 2 });
    limits.beginTool("catalog.search");
    limits.beginTool("quality.get_gaps");
    expect(limits.toolSteps).toBe(2);
    limits.beginTool("catalog.get");
    limits.beginTool("catalog.get");
    expect(limits.detailReads).toBe(2);
    expect(limits.toolSteps).toBe(2);
    expect(() => limits.beginTool("quality.get_gaps")).toThrow(
      StudioTurnStepBudgetError,
    );
    expect(() => limits.beginTool("catalog.get")).toThrow(
      StudioTurnStepBudgetError,
    );
  });

  it("enforces the wall-clock deadline on every check", () => {
    let now = 0;
    const limits = createStudioTurnLimits({ now: () => now, deadlineMs: 100 });
    limits.assertActive();
    now = 100;
    expect(() => limits.assertActive()).toThrow(StudioTurnDeadlineError);
    expect(() => limits.beginTool("catalog.search")).toThrow(
      StudioTurnDeadlineError,
    );
  });

  it("bounds model calls and exposes the default budgets", () => {
    const limits = createStudioTurnLimits({ maxModelCalls: 1 });
    limits.beginModel();
    expect(() => limits.beginModel()).toThrow(StudioTurnStepBudgetError);
    expect(STUDIO_TURN_DEADLINE_MS).toBe(45_000);
    expect(STUDIO_MAX_TOOL_STEPS).toBe(6);
    expect(STUDIO_MAX_DETAIL_READS).toBe(20);
    expect(STUDIO_MAX_MODEL_CALLS).toBe(2);
  });

  it("rejects invalid budgets", () => {
    expect(() => createStudioTurnLimits({ deadlineMs: 0 })).toThrow(TypeError);
    expect(() => createStudioTurnLimits({ maxToolSteps: 0 })).toThrow(TypeError);
    expect(() =>
      createStudioTurnLimits({ maxModelCalls: 1.5 }),
    ).toThrow(TypeError);
  });
});

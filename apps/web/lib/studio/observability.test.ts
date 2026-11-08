import { afterEach, describe, expect, it, vi } from "vitest";

import {
  budgetAlertEvent,
  budgetAlertLevel,
  emitStudioEvent,
  turnMetricEvent,
} from "./observability.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turn metrics", () => {
  it("shapes a content-free metric line with bounded counters", () => {
    const event = turnMetricEvent({
      status: "answered",
      durationMs: 1234.6,
      toolSteps: 3,
      detailReads: 2,
      modelCalls: 1,
      traceSteps: 6,
      outputCount: 1,
      limitationCount: 2,
      settledUsd: "0.020000",
    });
    expect(event).toEqual({
      event: "studio.turn.metrics",
      status: "answered",
      durationMs: 1235,
      toolSteps: 3,
      detailReads: 2,
      modelCalls: 1,
      traceSteps: 6,
      outputCount: 1,
      limitationCount: 2,
      settledUsd: "0.020000",
    });
    expect(Object.keys(event).sort()).toEqual(
      [
        "detailReads",
        "durationMs",
        "event",
        "limitationCount",
        "modelCalls",
        "outputCount",
        "settledUsd",
        "status",
        "toolSteps",
        "traceSteps",
      ].sort(),
    );
  });

  it("never includes negative or non-finite counters and carries a safe failure code", () => {
    const event = turnMetricEvent({
      status: "failed",
      durationMs: Number.NaN,
      toolSteps: -2,
      detailReads: 0,
      modelCalls: 0,
      traceSteps: 0,
      outputCount: 0,
      limitationCount: 0,
      settledUsd: null,
      errorCode: "studio_turn_timeout",
    });
    expect(event.durationMs).toBe(0);
    expect(event.toolSteps).toBe(0);
    expect(event.errorCode).toBe("studio_turn_timeout");
  });
});

describe("budget alert thresholds", () => {
  it("returns nothing below 80% or when no cap is configured", () => {
    expect(budgetAlertLevel("0", null)).toBeNull();
    expect(budgetAlertLevel("0", "10.000000")).toBeNull();
    expect(budgetAlertLevel("7.999999", "10.000000")).toBeNull();
  });

  it("warns from 80% and reports exhaustion at the cap", () => {
    expect(budgetAlertLevel("8", "10.000000")).toBe("warning");
    expect(budgetAlertLevel("9.99", "10.000000")).toBe("warning");
    expect(budgetAlertLevel("10", "10")).toBe("exhausted");
    expect(budgetAlertLevel("12.5", "10")).toBe("exhausted");
  });

  it("treats a non-positive cap with committed spend as exhausted", () => {
    expect(budgetAlertLevel("0", "0")).toBe("warning");
    expect(budgetAlertLevel("0.01", "0")).toBe("exhausted");
  });

  it("shapes an alert line with utilisation and no identifiers", () => {
    const event = budgetAlertEvent({
      committedUsd: "8.500000",
      budgetUsd: "10.000000",
      level: "warning",
    });
    expect(event).toEqual({
      event: "studio.budget.alert",
      level: "warning",
      scope: "workspace",
      committedUsd: "8.500000",
      budgetUsd: "10.000000",
      utilizationPercent: 85,
    });
  });
});

describe("log emission", () => {
  it("writes exactly one parseable JSON line to console.info", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    emitStudioEvent(
      turnMetricEvent({
        status: "partial",
        durationMs: 12,
        toolSteps: 1,
        detailReads: 0,
        modelCalls: 0,
        traceSteps: 2,
        outputCount: 0,
        limitationCount: 1,
        settledUsd: null,
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(JSON.parse(String(line))).toMatchObject({
      event: "studio.turn.metrics",
      status: "partial",
    });
  });
});

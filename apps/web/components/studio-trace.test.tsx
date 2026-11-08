import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StudioTraceStep } from "../lib/studio/types";
import { StudioTrace } from "./studio-trace";

function step(overrides: Partial<StudioTraceStep>): StudioTraceStep {
  return {
    kind: "tool",
    toolId: "catalog.search",
    state: "done",
    durationMs: null,
    detail: {
      key: "studio.trace.tool.done",
      values: { tool: "catalog.search", durationMs: 12 },
    },
    ...overrides,
  };
}

function render(steps: StudioTraceStep[] | null, overrides = {}) {
  return renderToStaticMarkup(
    <StudioTrace
      locale="en"
      stepCount={steps?.length ?? 2}
      steps={steps}
      {...overrides}
    />,
  );
}

describe("StudioTrace", () => {
  it("renders a collapsed details summary with the persisted step count", () => {
    const html = render([step({})]);

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Execution trace · 1 steps");
  });

  it("renders each step in order inside a semantic ordered list", () => {
    const html = render([
      step({ toolId: "catalog.search" }),
      step({
        toolId: "jobs.list",
        detail: {
          key: "studio.trace.tool.done",
          values: { tool: "jobs.list", durationMs: 4 },
        },
      }),
    ]);

    expect(html).toContain("<ol");
    expect(html.indexOf("Search catalog")).toBeLessThan(
      html.indexOf("List jobs"),
    );
  });

  it("labels a known tool id readably and falls back for an unknown one", () => {
    const known = render([step({ toolId: "jobs.list" })]);
    expect(known).toContain("List jobs");

    const unknown = render([step({ toolId: "future.tool" })]);
    expect(unknown).toContain("Tool future.tool");
  });

  it.each([
    ["started", "Started"],
    ["running", "Running"],
    ["done", "Done"],
    ["failed", "Failed"],
    ["unavailable", "Unavailable"],
    ["blocked", "Blocked"],
    ["info", "Info"],
  ] as ReadonlyArray<[string, string]>)(
    "renders the persisted %s status with its own label",
    (state, label) => {
      const html = render([step({ state: state as StudioTraceStep["state"] })]);
      expect(html).toContain(`data-state="${state}"`);
      expect(html).toContain(label);
    },
  );

  it("never shows a failed read as done", () => {
    const html = render([
      step({
        state: "unavailable",
        detail: {
          key: "studio.trace.tool.unavailable",
          values: { tool: "catalog.search", durationMs: 8 },
        },
      }),
    ]);

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Unavailable");
    expect(html).toContain("catalog.search was unavailable (8 ms).");
    // The only "Done" the step could show would be the failure line's copy.
    expect(html).not.toContain(">Done<");
  });

  it("shows a duration only when the step stored one", () => {
    const withDuration = render([step({ durationMs: 250 })]);
    expect(withDuration).toContain("250 ms");

    const withoutDuration = render([step({ durationMs: null })]);
    expect(withoutDuration).not.toContain(">250 ms<");
  });

  it("renders the model budget-blocked step honestly", () => {
    const html = render([
      step({
        kind: "model",
        toolId: null,
        state: "blocked",
        detail: { key: "studio.trace.model.budget_blocked", values: {} },
      }),
    ]);
    expect(html).toContain("Budget did not admit a model analysis");
    expect(html).toContain("Blocked");
  });

  it("falls back to generic copy instead of a raw key for an unknown detail", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const html = render([
      step({ detail: { key: "studio.trace.from_the_future", values: {} } }),
    ]);
    expect(html).not.toContain("studio.trace.from_the_future");
    expect(html).toContain("This step&#x27;s content could not be displayed.");
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it("offers a load action before steps are loaded, and while loading", () => {
    const onLoad = vi.fn();
    const notLoaded = render(null, { onLoad });
    expect(notLoaded).toContain("Load execution trace");

    const loading = render(null, { onLoad, loading: true });
    expect(loading).toContain("Loading execution trace…");

    const failed = render(null, { onLoad, error: true });
    expect(failed).toContain("The execution trace could not be loaded.");
    expect(failed).toContain('role="alert"');
  });

  it("shows the honest empty line for a reply with no steps", () => {
    const html = render([]);
    expect(html).toContain("This reply has no displayable execution steps.");
  });
});

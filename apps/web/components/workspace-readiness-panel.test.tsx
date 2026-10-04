// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
import { WorkspaceReadinessPanel } from "./workspace-readiness-panel";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe("runtime readiness display", () => {
  it("keeps unknown checks distinct from ready observations and retries a failed read", async () => {
    let available = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        available
          ? Response.json({
              items: [
                {
                  key: "storage",
                  state: "unknown",
                  checkedAt: null,
                  safeReason: "No safe health observation",
                  nextAction: "Ask support",
                },
                {
                  key: "reviewer",
                  state: "ready",
                  checkedAt: "2026-10-01T10:00:00Z",
                  safeReason: "Active reviewer exists",
                  nextAction: "Assign review",
                },
              ],
            })
          : Response.json({}, { status: 503 }),
      ),
    );
    const c = document.createElement("div");
    document.body.append(c);
    const root = createRoot(c);
    try {
      await act(async () =>
        root.render(createElement(WorkspaceReadinessPanel)),
      );
      expect(c.querySelector('[role="alert"]')?.textContent).toContain(
        "unavailable",
      );
      available = true;
      await act(async () =>
        c.querySelector<HTMLButtonElement>("button")!.click(),
      );
      expect(c.querySelector('[role="alert"]')).toBeNull();
      expect(c.textContent).toContain("Storage · Unknown");
      expect(c.textContent).toContain("Reviewer · Ready (observed)");
      expect(c.textContent).toContain("No safe check available");
    } finally {
      await act(async () => root.unmount());
      c.remove();
      vi.unstubAllGlobals();
    }
  });
});

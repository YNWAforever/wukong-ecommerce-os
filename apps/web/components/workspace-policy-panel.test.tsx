// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
import { WorkspacePolicyPanel } from "./workspace-policy-panel";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe("workspace policy editing", () => {
  it("retains an edit when a concurrent admin saved first and keeps unknown spend visible", async () => {
    const view = {
      policy: {
        name: "Second shop",
        tone: "Plain",
        claimPolicy: [],
        requiredFields: [],
        sourcePreferences: { allowedDomains: [] },
      },
      digest: "a".repeat(64),
      usage: {
        heldUsd: "1",
        unknownHeldUsd: "2.5",
        settledUsd: "0.25",
        unknownRuns: 1,
        physicalCalls: 2,
      },
      admission: { enabled: false, provider: null, model: null, capUsd: null },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(view)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Settings changed. Reload and reapply your changes.",
          }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(WorkspacePolicyPanel));
      });
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, "Changed name");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const save = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save policies"),
      )!;
      await act(async () => {
        save.click();
      });
      expect(container.querySelector("[role=alert]")?.textContent).toContain(
        "Settings changed",
      );
      expect(input.value).toBe("Changed name");
      expect(container.textContent).toContain("2.5");
      const body = JSON.parse(fetcher.mock.calls[1]![1].body);
      expect(body).toMatchObject({
        expectedDigest: view.digest,
        policy: { name: "Changed name" },
      });
      expect(body.policy).not.toHaveProperty("listingAi");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

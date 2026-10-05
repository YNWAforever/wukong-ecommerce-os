// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ListingReviewClient } from "./listing-review-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("renders a correlated blocked identity with retry and no mutation controls", async () => {
  const requestId = "00000000-0000-4000-8000-000000000125";
  const listingId = "00000000-0000-4000-8000-000000000101";
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      listingId,
      status: "in_review",
      readState: "blocked",
      activeVersion: null,
      readFailure: { reason: "invalid_active_version", requestId },
      permissions: {
        canApprove: false,
        canDeliver: false,
        canEdit: false,
        canProcess: false,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(ListingReviewClient, { listingId })),
    );
    expect(container.textContent).toContain(requestId);
    expect(container.textContent).toContain(listingId);
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.querySelector("input,textarea,form")).toBeNull();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => /重試|Retry/.test(button.textContent ?? ""),
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchClient } from "./workbench-client";
const navigation = vi.hoisted(() => ({ search: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: navigation.push }),
}));
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(WorkbenchClient));
  });
}
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
function page(title = "Actual listing") {
  return {
    items: [
      {
        key: "listing:1",
        id: "1",
        kind: "listing",
        state: "attention",
        reason: "review",
        title,
        sourceLabel: null,
        productCount: 1,
        occurredAt: "2026-09-06T00:00:00Z",
        timestampKind: "updated",
      },
    ],
    counts: { attention: 30, progress: 2, completed: 4, unclassified: 1 },
    totalMatching: 30,
    page: 1,
    pageSize: 25,
    observedAt: "2026-09-06T00:00:00Z",
    capabilities: {
      canImport: true,
      canReview: true,
      canRecordImportResult: true,
    },
  };
}
function response(body = page()) {
  return new Response(JSON.stringify(body));
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  )!;
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  navigation.search = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("shows loading without invented zero metrics, then first-read error and Retry", async () => {
  let reject!: (e: Error) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    ),
  );
  await mount();
  expect(container.textContent).toContain("Loading");
  expect(container.querySelector(".workbench-summary strong")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(container.textContent).toContain("Unable to load");
  expect(button("Retry")).toBeTruthy();
  expect(container.textContent).not.toContain("No tasks");
});
it("retains same-query data after failed focus refresh with explicit stale status", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response())
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  await mount();
  await settle();
  expect(container.textContent).toContain("30");
  await act(async () => window.dispatchEvent(new Event("focus")));
  await settle();
  expect(container.textContent).toContain("Actual listing");
  expect(container.textContent).toContain("Stale");
  expect(container.textContent).toContain("Observed");
});
it("clears old query membership and ignores reversed responses on query-only navigation and Back", async () => {
  const pending: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise((r) => pending.push(r))),
  );
  await mount();
  await act(async () => pending[0]!(response()));
  navigation.search = "state=completed";
  await render();
  expect(container.textContent).not.toContain("Actual listing");
  navigation.search = "state=progress";
  await render();
  await act(async () => pending[2]!(response(page("Current progress"))));
  await act(async () => pending[1]!(response(page("Late completed"))));
  expect(container.textContent).toContain("Current progress");
  expect(container.textContent).not.toContain("Late completed");
  navigation.search = "";
  await render();
  expect(container.textContent).not.toContain("Current progress");
  expect(button("Needs attention").getAttribute("aria-pressed")).toBe("true");
});
it("shows filtered emptiness, unavailable count and preserves return context", async () => {
  navigation.search = "state=completed&kind=export&page=2";
  const body = page();
  body.items = [];
  body.totalMatching = 0;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
  await mount();
  await settle();
  expect(container.textContent).toContain("No tasks");
  expect(container.textContent).toContain("Status unavailable");
  await act(async () => button("In progress").click());
  expect(navigation.push).toHaveBeenCalledWith(
    "/dashboard?state=progress&kind=export&page=1",
  );
});
it("links exact record with current context and hides import for viewers", async () => {
  navigation.search = "state=attention&kind=listing&page=2";
  const body = page();
  body.capabilities = {
    canImport: false,
    canReview: false,
    canRecordImportResult: false,
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
  await mount();
  await settle();
  expect(
    container.querySelector('a[href^="/listings/1"]')?.getAttribute("href"),
  ).toContain(
    "returnTo=%2Fdashboard%3Fstate%3Dattention%26kind%3Dlisting%26page%3D2",
  );
  expect(container.textContent).toContain("Read-only");
  expect(container.querySelector('a[href="/listings/import"]')).toBeNull();
});

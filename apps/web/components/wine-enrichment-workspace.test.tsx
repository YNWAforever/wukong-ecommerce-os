// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { WineEnrichmentWorkspace } from "./wine-enrichment-workspace";
import { progress } from "./wine-ui-test-fixtures";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, el: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
const proposal = {
  runId: progress.runId,
  inputRevision: 2,
  baseVersionId: "00000000-0000-4000-8000-000000000102",
  contentDigest: "digest",
  current: { inputRevision: 2, activeVersionId: "current" },
  state: "available",
  reason: null,
  adoptedVersionId: null,
  differences: [
    {
      path: "sections.pairing",
      kind: "section",
      before: { en: "Before", "zh-Hant": "以前" },
      after: { en: "After", "zh-Hant": "之後" },
      selectable: true,
      reason: null,
    },
  ],
};
const snapshot = {
  listingId: "00000000-0000-4000-8000-000000000103",
  wineProgress: { ...progress, state: "awaiting_adoption" },
  inputRevision: 2,
  workingInput: {
    revision: 2,
    baseVersionId: proposal.baseVersionId,
    workingContent: emptyWorkingListing(),
    fieldStates: {},
    sources: [],
    note: null,
  },
  activeVersion: null,
  permissions: { canProcess: true, canEdit: true },
} as any;
async function render(
  fetcher: any,
  refresh = vi.fn().mockResolvedValue(undefined),
) {
  vi.stubGlobal("fetch", fetcher);
  el = document.createElement("div");
  root = createRoot(el);
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={snapshot}
        onRefresh={refresh}
        externalDirty={false}
      />,
    ),
  );
  return refresh;
}
it("shows bilingual differences before guarded atomic adoption and refreshes current state", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation((_url: string, init: any) =>
      Promise.resolve(
        Response.json(
          init?.method === "POST"
            ? { versionId: "old", current: { activeVersionId: "later" } }
            : proposal,
        ),
      ),
    );
  const refresh = await render(fetcher);
  expect(el.textContent).toContain("Before");
  expect(el.textContent).toContain("Pairing");
  expect(
    el
      .querySelector('[data-proposal-path="sections.pairing"]')
      ?.closest("legend")?.textContent,
  ).not.toContain("sections.");
  expect(el.textContent).toContain("After");
  await act(async () =>
    (
      el.querySelector(
        '[data-proposal-path="sections.pairing"]',
      ) as HTMLInputElement
    ).click(),
  );
  await act(async () =>
    (
      el.querySelector('[data-action="adopt-wine"]') as HTMLButtonElement
    ).click(),
  );
  const call = fetcher.mock.calls.find((c: any) => c[1]?.method === "POST")!;
  expect(call[0]).toContain(`/proposals/${progress.runId}/adopt`);
  expect(JSON.parse(call[1].body)).toEqual({
    expectedInputRevision: 2,
    baseVersionId: proposal.baseVersionId,
    selectedPaths: ["sections.pairing"],
  });
  expect(call[1].headers["Idempotency-Key"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(refresh).toHaveBeenCalled();
});
it("surfaces composition conflicts and reloads server eligibility", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation((_url: string, init: any) =>
      Promise.resolve(
        init?.method === "POST"
          ? Response.json(
              { error: { code: "proposal_current_changed" } },
              { status: 409 },
            )
          : Response.json(proposal),
      ),
    );
  const refresh = await render(fetcher);
  await act(async () =>
    (el.querySelector("[data-proposal-path]") as HTMLInputElement).click(),
  );
  await act(async () =>
    (
      el.querySelector('[data-action="adopt-wine"]') as HTMLButtonElement
    ).click(),
  );
  expect(el.querySelector('[role="alert"]')?.textContent).toContain("changed");
  expect(refresh).toHaveBeenCalled();
  expect(
    fetcher.mock.calls.filter((c: any) => c[1]?.cache === "no-store").length,
  ).toBeGreaterThan(1);
});
it("keeps historical adoption separate and does not offer another adoption", async () => {
  await render(
    vi.fn().mockResolvedValue(
      Response.json({
        ...proposal,
        state: "adopted",
        adoptedVersionId: "old-adopted",
        current: { inputRevision: 3, activeVersionId: "new-current" },
      }),
    ),
  );
  expect(el.textContent).toContain("old-adopted");
  expect(el.textContent).toContain("new-current");
  expect(el.querySelector('[data-action="adopt-wine"]')).toBeNull();
});

it("uses distinct research and copy routes with exact current guards", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(Response.json(proposal)));
  await render(fetcher);
  for (const label of ["Re-research", "Regenerate all copy (no search)"]) {
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((button) => button.textContent === label)!
        .click();
    });
  }
  const calls = fetcher.mock.calls.filter((c: any) => c[1]?.method === "POST");
  expect(calls).toHaveLength(2);
  expect(calls[0]![0]).toBe(
    `/api/listings/${snapshot.listingId}/wine-enrichment`,
  );
  expect(calls[1]![0]).toBe(
    `/api/listings/${snapshot.listingId}/wine-enrichment/regenerate`,
  );
  expect(JSON.parse(calls[0]![1].body)).toEqual({
    expectedInputRevision: 2,
    baseVersionId: proposal.baseVersionId,
    mode: "research",
  });
  expect(JSON.parse(calls[1]![1].body)).toEqual({
    expectedInputRevision: 2,
    baseVersionId: proposal.baseVersionId,
    mode: "copy",
  });
  expect(el.textContent).toContain("no Tavily search");
});
it("remounts with the current durable stage while retaining an older review version", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(proposal));
  await render(fetcher);
  await act(async () => root.unmount());
  root = createRoot(el);
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={{
          ...snapshot,
          wineProgress: {
            ...progress,
            state: "running",
            stage: "quality_check",
            completedStages: ["extraction", "generation"],
          },
        }}
        onRefresh={async () => {}}
        externalDirty={false}
      />,
    ),
  );
  expect(
    el.querySelector('[aria-current="step"]')?.getAttribute("data-stage"),
  ).toBe("quality_check");
  expect(
    (
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Re-research",
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

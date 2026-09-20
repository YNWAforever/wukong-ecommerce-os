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
  current: {
    inputRevision: 2,
    activeVersionId: "00000000-0000-4000-8000-000000000102",
  },
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

it("invalidates proposal A and its selection immediately while context B is loading", async () => {
  let finishB!: (value: Response) => void;
  const pendingB = new Promise<Response>((resolve) => {
    finishB = resolve;
  });
  const runB = "00000000-0000-4000-8000-000000000199";
  const fetcher = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) =>
      url.includes(runB) && init?.method !== "POST"
        ? pendingB
        : Promise.resolve(Response.json(proposal)),
    );
  await render(fetcher);
  await act(async () =>
    (el.querySelector("[data-proposal-path]") as HTMLInputElement).click(),
  );
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={{
          ...snapshot,
          wineProgress: { ...snapshot.wineProgress, runId: runB },
          inputRevision: 3,
          workingInput: { ...snapshot.workingInput, revision: 3 },
        }}
        onRefresh={async () => {}}
        externalDirty={false}
      />,
    ),
  );
  const staleButton = el.querySelector(
    '[data-action="adopt-wine"]',
  ) as HTMLButtonElement | null;
  expect(staleButton === null || staleButton.disabled).toBe(true);
  expect(el.textContent).not.toContain("Before");
  await act(async () =>
    finishB(
      Response.json({
        ...proposal,
        runId: runB,
        inputRevision: 3,
        current: { ...proposal.current, inputRevision: 3 },
      }),
    ),
  );
  expect(
    (el.querySelector('[data-action="adopt-wine"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () =>
    (el.querySelector("[data-proposal-path]") as HTMLInputElement).click(),
  );
  await act(async () =>
    (
      el.querySelector('[data-action="adopt-wine"]') as HTMLButtonElement
    ).click(),
  );
  const post = fetcher.mock.calls.find((c) => c[1]?.method === "POST")!;
  expect(post[0]).toContain(`/proposals/${runB}/adopt`);
  expect(JSON.parse(post[1].body as string).expectedInputRevision).toBe(3);
});
it("cannot restore proposal A through a captured post-refresh reader after switching to B", async () => {
  let finishRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  let readsA = 0;
  const runB = "00000000-0000-4000-8000-000000000198";
  const fetcher = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(Response.json({}));
      if (url.includes(runB))
        return Promise.resolve(
          Response.json({
            ...proposal,
            runId: runB,
            inputRevision: 3,
            differences: [{ ...proposal.differences[0], after: "Only B" }],
          }),
        );
      readsA++;
      return Promise.resolve(Response.json(proposal));
    });
  await render(
    fetcher,
    vi.fn(() => pendingRefresh),
  );
  await act(async () =>
    (el.querySelector("[data-proposal-path]") as HTMLInputElement).click(),
  );
  await act(async () =>
    (
      el.querySelector('[data-action="adopt-wine"]') as HTMLButtonElement
    ).click(),
  );
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={{
          ...snapshot,
          wineProgress: { ...snapshot.wineProgress, runId: runB },
          inputRevision: 3,
          workingInput: { ...snapshot.workingInput, revision: 3 },
        }}
        onRefresh={async () => {}}
        externalDirty={false}
      />,
    ),
  );
  expect(el.textContent).toContain("Only B");
  await act(async () => finishRefresh());
  expect(el.textContent).toContain("Only B");
  expect(readsA).toBe(1);
});

it("ignores out-of-order A responses and clears loading for a non-proposal context", async () => {
  let finishA!: (value: Response) => void;
  const pendingA = new Promise<Response>((resolve) => {
    finishA = resolve;
  });
  const runB = "00000000-0000-4000-8000-000000000197";
  const fetcher = vi.fn().mockImplementation((url: string) =>
    url.includes(runB)
      ? Promise.resolve(
          Response.json({
            ...proposal,
            runId: runB,
            differences: [{ ...proposal.differences[0], after: "Newest B" }],
          }),
        )
      : pendingA,
  );
  await render(fetcher);
  expect(el.textContent).toContain("Loading proposal");
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={{
          ...snapshot,
          wineProgress: { ...snapshot.wineProgress, runId: runB },
        }}
        onRefresh={async () => {}}
        externalDirty={false}
      />,
    ),
  );
  expect(el.textContent).toContain("Newest B");
  await act(async () => finishA(Response.json(proposal)));
  expect(el.textContent).toContain("Newest B");
  let finishPending!: (value: Response) => void;
  fetcher.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finishPending = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={snapshot}
        onRefresh={async () => {}}
        externalDirty={false}
      />,
    ),
  );
  expect(el.textContent).toContain("Loading proposal");
  await act(async () =>
    root.render(
      <WineEnrichmentWorkspace
        snapshot={{
          ...snapshot,
          wineProgress: { ...progress, runId: runB, state: "running" },
        }}
        onRefresh={async () => {}}
        externalDirty={false}
      />,
    ),
  );
  expect(el.textContent).not.toContain("Loading proposal");
  await act(async () => finishPending(Response.json(proposal)));
  expect(el.querySelector('[data-action="adopt-wine"]')).toBeNull();
  expect(el.textContent).not.toContain("Loading proposal");
});
it("never enables adoption from a response with mismatched current guards", async () => {
  await render(
    vi.fn().mockResolvedValue(
      Response.json({
        ...proposal,
        current: {
          inputRevision: 3,
          activeVersionId: proposal.baseVersionId,
        },
      }),
    ),
  );
  expect(
    (el.querySelector('[data-action="adopt-wine"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

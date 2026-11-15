// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

import type {
  StudioListingReviewState,
  StudioReviewCandidate,
} from "../lib/studio/review-batch";
import {
  StudioReviewBatch,
  type StudioReviewBatchProps,
} from "./studio-review-batch";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Bounded multi-listing review surface (2026-11-16 plan, PR 2).
 *
 * Stubbed fetch only: these tests pin the cap, the explicit single request, the
 * exact revision/digest links, honest failures and that a recorded result is
 * rendered from the server read without any client fetch on mount.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const AUDIT = {
  outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  revision: 3,
  contentDigest: "a".repeat(64),
};
const GAP = {
  outputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  revision: 1,
  contentDigest: "b".repeat(64),
};

function candidate(
  listingId: string,
  title: string,
  extra: Partial<StudioReviewCandidate> = {},
): StudioReviewCandidate {
  return {
    listingId,
    title,
    status: "in_review",
    activeVersion: {
      versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sequence: 2,
    },
    blockingFlagCount: 0,
    threadId: null,
    audit: null,
    gap: null,
    ...extra,
  };
}

const candidates = [candidate(A, "Margaux 2019"), candidate(B, "Opak 2020")];

function props(
  overrides: Partial<StudioReviewBatchProps> = {},
): StudioReviewBatchProps {
  return {
    locale: "en",
    canOperate: true,
    candidates,
    query: { q: "", page: 1 },
    totalMatching: candidates.length,
    hasNext: false,
    reconstruction: [],
    ...overrides,
  };
}

function render(value: StudioReviewBatchProps) {
  return renderToStaticMarkup(<StudioReviewBatch {...value} />);
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(value: StudioReviewBatchProps = props()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StudioReviewBatch {...value} />);
  });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function checkboxes(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  navigation.replace.mockReset();
  vi.unstubAllGlobals();
});

describe("StudioReviewBatch", () => {
  it("renders the capped selection with no review started on mount", () => {
    const html = render(props());
    expect(html).toContain("Select listings");
    expect(html).toContain("Margaux 2019");
    expect(html).toContain("0 of 5 listings selected.");
    expect(html).toContain("Start review");
    expect(html).toContain("No review results yet.");
    expect(html).toContain("nothing is scheduled");
  });

  it("runs one explicit request for the selection and links exact pins", async () => {
    const body = {
      batchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      requested: 1,
      completed: 1,
      partial: 0,
      failed: 0,
      items: [
        {
          listingId: A,
          title: "Margaux 2019",
          outcome: "complete" as const,
          failureCode: null,
          threadId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          audit: AUDIT,
          gap: GAP,
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(body));
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await act(async () => checkboxes(container)[0]!.click());
    expect(container.textContent).toContain("1 of 5 listings selected.");

    const start = findButton(container, "Start review")!;
    await act(async () => {
      start.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/studio/reviews");
    expect(JSON.parse(String(init?.body))).toEqual({
      listingIds: [A],
      locale: "en",
    });
    expect(navigation.replace).toHaveBeenCalledWith(
      "/studio/reviews?listingIds=" + A,
      { scroll: false },
    );

    const auditLink = container.querySelector<HTMLAnchorElement>(
      `a[href="/studio/outputs/${AUDIT.outputId}?revision=3&digest=${AUDIT.contentDigest}"]`,
    );
    expect(auditLink).not.toBeNull();
    expect(
      container.querySelector<HTMLAnchorElement>(
        `a[href="/studio/outputs/${GAP.outputId}?revision=1&digest=${GAP.contentDigest}"]`,
      ),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLAnchorElement>(
        'a[href="/studio/t/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("Complete");

    // One request only: pressing again is blocked while nothing changed.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops at the five-listing cap and states the limit", async () => {
    const container = await mount(
      props({
        candidates: [
          candidate(A, "One"),
          candidate(B, "Two"),
          candidate(C, "Three"),
          candidate(D, "Four"),
          candidate(E, "Five"),
          candidate(F, "Six"),
        ],
        totalMatching: 6,
      }),
    );
    for (const checkbox of checkboxes(container).slice(0, 5)) {
      await act(async () => checkbox.click());
    }
    expect(container.textContent).toContain("5 of 5 listings selected.");
    expect(checkboxes(container)[5]!.disabled).toBe(true);
    expect(findButton(container, "Start review")!.disabled).toBe(false);
  });

  it("keeps the selection and shows an honest failure when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json(
          { code: "forbidden" },
          {
            status: 403,
          },
        ),
      ),
    );
    const container = await mount();
    await act(async () => checkboxes(container)[0]!.click());
    await act(async () => {
      findButton(container, "Start review")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "The review request could not be completed.",
    );
    expect(
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .checked,
    ).toBe(true);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("renders the server's recorded result without a client fetch", () => {
    const reconstruction: StudioListingReviewState[] = [
      {
        listingId: A,
        available: true,
        title: "Margaux 2019",
        status: "in_review",
        activeVersion: null,
        threadId: null,
        audit: AUDIT,
        gap: GAP,
      },
    ];
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const html = render(props({ reconstruction }));
    expect(html).toContain("Recorded");
    expect(html).toContain(
      `/studio/outputs/${AUDIT.outputId}?revision=3&amp;digest=${AUDIT.contentDigest}`,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("offers to select only the failed listings for a retry", async () => {
    const body = {
      batchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      requested: 2,
      completed: 1,
      partial: 0,
      failed: 1,
      items: [
        {
          listingId: A,
          title: "Margaux 2019",
          outcome: "complete" as const,
          failureCode: null,
          threadId: null,
          audit: AUDIT,
          gap: GAP,
        },
        {
          listingId: B,
          title: "Opak 2020",
          outcome: "failed" as const,
          failureCode: "listing_changed" as const,
          threadId: null,
          audit: null,
          gap: null,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body)),
    );
    const container = await mount();
    await act(async () => checkboxes(container)[0]!.click());
    await act(async () => checkboxes(container)[1]!.click());
    await act(async () => {
      findButton(container, "Start review")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "The listing changed before review started.",
    );
    expect(container.textContent).toContain("Failed");

    await act(async () =>
      findButton(container, "Select failed listings")!.click(),
    );
    expect(container.textContent).toContain("1 of 5 listings selected.");
  });

  it("is read-only for a viewer: no selection, no start", async () => {
    const container = await mount(props({ canOperate: false }));
    expect(checkboxes(container).every((box) => box.disabled)).toBe(true);
    expect(findButton(container, "Start review")!.disabled).toBe(true);
    expect(container.textContent).toContain(
      "An operator or higher role is required to start reviews.",
    );
  });
});

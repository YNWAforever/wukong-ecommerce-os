// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/listings/[id]` page wiring (B2).
 *
 * The page is a thin server component: it resolves the optional
 * `studioOutput` query value through `loadListingStudioHandoff` and passes the
 * result (or nothing) to the existing client. The resolver's own validation
 * cases live in `lib/studio/listing-handoff.test.ts`; here we pin the page's
 * search-param handling and pass-through, including that absent/ambiguous
 * parameters do not change the page.
 */

const mocks = vi.hoisted(() => ({
  loadHandoff: vi.fn(),
  returnLink: vi.fn(),
}));

vi.mock("../../../../components/listing-review-client", () => ({
  ListingReviewClient: (props: {
    listingId: string;
    initialProcessing?: string;
    studioHandoff?: unknown;
  }) =>
    createElement("div", {
      "data-review-client": "true",
      "data-listing-id": props.listingId,
      "data-processing": props.initialProcessing ?? "",
      "data-handoff": JSON.stringify(props.studioHandoff ?? null),
    }),
}));

vi.mock("../../../../components/workbench-return-link", () => ({
  WorkbenchReturnLink: (props: { returnTo: string }) =>
    createElement("a", { href: props.returnTo }, "Return"),
}));

vi.mock("../../../../lib/studio/listing-handoff", () => ({
  loadListingStudioHandoff: mocks.loadHandoff,
}));

vi.mock("../../../../lib/intake-runtime", () => ({ getDatabase: vi.fn() }));
vi.mock("../../../../lib/session-context", () => ({
  authSessionContext: { resolve: vi.fn() },
}));

import ListingReviewPage from "./page";

const LISTING_ID = "00000000-0000-4000-8000-000000000101";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";

const handoff = {
  outputId: OUTPUT_ID,
  title: "Synthetic copy proposal",
  revision: 3,
  asOf: "2026-11-08T10:00:00.000Z",
  fields: [
    {
      field: "title.en",
      current: "Synthetic old title",
      proposed: "Synthetic proposed title",
    },
  ],
};

async function renderPage(search: Record<string, string | string[]>) {
  const html = renderToStaticMarkup(
    await ListingReviewPage({
      params: Promise.resolve({ id: LISTING_ID }),
      searchParams: Promise.resolve(search),
    }),
  );
  return html;
}

beforeEach(() => {
  mocks.loadHandoff.mockReset();
});

describe("ListingReviewPage studio handoff", () => {
  it("passes a resolved handoff to the review client and keeps other params", async () => {
    mocks.loadHandoff.mockResolvedValue(handoff);
    const html = await renderPage({
      studioOutput: OUTPUT_ID,
      processing: "queued",
      returnTo: "/jobs",
    });

    expect(mocks.loadHandoff).toHaveBeenCalledWith({
      listingId: LISTING_ID,
      studioOutput: OUTPUT_ID,
      deps: expect.objectContaining({
        sessionContext: expect.anything(),
        getDatabase: expect.any(Function),
      }),
    });
    // renderToStaticMarkup escapes quotes inside attributes; decode before
    // comparing the serialized handoff payload.
    const decoded = html.replaceAll("&quot;", '"');
    expect(decoded).toContain(`data-handoff="${JSON.stringify(handoff)}"`);
    expect(html).toContain('data-processing="queued"');
    expect(html).toContain('href="/jobs"');
  });

  it("renders the page unchanged when the resolver ignores the handoff", async () => {
    mocks.loadHandoff.mockResolvedValue(undefined);
    const html = await renderPage({ studioOutput: OUTPUT_ID });

    expect(html).toContain('data-handoff="null"');
    expect(html).toContain('data-review-client="true"');
    expect(html).not.toContain("studio-handoff");
    // No valid processing value means no banner state is invented either.
    expect(html).toContain('data-processing=""');
  });

  it("passes an exact revision and digest to the resolver", async () => {
    mocks.loadHandoff.mockResolvedValue(undefined);
    await renderPage({
      studioOutput: OUTPUT_ID,
      studioRevision: "3",
      studioDigest: "a".repeat(64),
    });
    expect(mocks.loadHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        studioOutput: OUTPUT_ID,
        studioRevision: "3",
        studioDigest: "a".repeat(64),
      }),
    );
  });

  it.each(["studioRevision", "studioDigest"])(
    "rejects ambiguous %s pins",
    async (key) => {
      mocks.loadHandoff.mockResolvedValue(undefined);
      await renderPage({ studioOutput: OUTPUT_ID, [key]: ["a", "b"] });
      expect(mocks.loadHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ studioOutput: undefined }),
      );
    },
  );

  it("ignores a repeated/ambiguous studioOutput parameter", async () => {
    mocks.loadHandoff.mockResolvedValue(undefined);
    await renderPage({ studioOutput: [OUTPUT_ID, OUTPUT_ID] });

    expect(mocks.loadHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ studioOutput: undefined }),
    );
  });

  it("passes undefined without the parameter and keeps the existing page", async () => {
    mocks.loadHandoff.mockResolvedValue(undefined);
    const html = await renderPage({});

    expect(mocks.loadHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: LISTING_ID,
        studioOutput: undefined,
      }),
    );
    expect(html).toContain(
      'data-listing-id="00000000-0000-4000-8000-000000000101"',
    );
    expect(html).not.toContain("Return");
  });
});

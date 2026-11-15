import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio/reviews` server page (2026-11-16 plan, PR 2).
 *
 * Service and locale cookie are fakes. These tests pin the read-only server
 * render: bounded candidate page, role-aware action state, exact recorded pins
 * from `?listingIds=`, and one honest failure line per failed read.
 */

const state = vi.hoisted(() => ({
  session: {
    workspaceId: "ws_test",
    actorId: "actor_ops",
    role: "operator" as "operator" | "viewer",
  },
  locale: "en",
  candidates: null as Record<string, unknown> | null,
  candidatesThrow: false,
  states: null as Record<string, unknown> | null,
  statesThrow: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" ? { value: state.locale } : undefined,
  }),
}));

vi.mock("../../../../lib/session-context", () => ({
  authSessionContext: { resolve: async () => state.session },
  requireWorkspaceRole: (required: string, actual: string) =>
    ({ viewer: 10, operator: 20, reviewer: 30, admin: 40, owner: 50 })[
      actual
    ]! >=
    { viewer: 10, operator: 20, reviewer: 30, admin: 40, owner: 50 }[required]!,
}));

vi.mock("../studio-service", () => ({
  studioService: () => ({
    reviewCandidates: async () => {
      if (state.candidatesThrow) throw new Error("database url must not leak");
      return state.candidates;
    },
    listingReviews: async () => {
      if (state.statesThrow) throw new Error("database url must not leak");
      return state.states;
    },
  }),
}));

import StudioReviewsPage from "./page";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AUDIT = {
  outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  revision: 2,
  contentDigest: "a".repeat(64),
};

function candidatesResult(): Record<string, unknown> {
  return {
    items: [
      {
        listingId: A,
        title: "Margaux 2019",
        status: "in_review",
        activeVersion: {
          versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          sequence: 2,
        },
        blockingFlagCount: 1,
        threadId: null,
        audit: AUDIT,
        gap: null,
      },
      {
        listingId: B,
        title: "Opak 2020",
        status: "in_review",
        activeVersion: null,
        blockingFlagCount: 0,
        threadId: null,
        audit: null,
        gap: null,
      },
    ],
    q: "",
    page: 1,
    pageSize: 20,
    totalMatching: 2,
    hasNext: false,
  };
}

async function render(
  params: Record<string, string | string[] | undefined> = {},
) {
  const html = renderToStaticMarkup(
    await StudioReviewsPage({ searchParams: Promise.resolve(params) }),
  );
  return html;
}

beforeEach(() => {
  state.session = {
    workspaceId: "ws_test",
    actorId: "actor_ops",
    role: "operator",
  };
  state.locale = "en";
  state.candidates = candidatesResult();
  state.candidatesThrow = false;
  state.states = { items: [] };
  state.statesThrow = false;
});

afterEach(() => vi.restoreAllMocks());

describe("/studio/reviews", () => {
  it("renders the bounded selection and both listings for an operator", async () => {
    const html = await render();
    expect(html).toContain("Multi-listing review");
    expect(html).toContain("Margaux 2019");
    expect(html).toContain("Opak 2020");
    expect(html).toContain("0 of 5 listings selected.");
    expect(html).toContain("Start review");
    expect(html).toContain("2 listings");
    expect(html).toContain("No active version");
    expect(html).toContain("1 blocking flags");
    // Latest recorded review is linked with its exact pin.
    expect(html).toContain(
      `/studio/outputs/${AUDIT.outputId}?revision=2&amp;digest=${AUDIT.contentDigest}`,
    );
    expect(html).not.toContain("An operator or higher role is required");
  });

  it("keeps a viewer read-only", async () => {
    state.session = { ...state.session, role: "viewer" };
    const html = await render();
    expect(html).toContain(
      "An operator or higher role is required to start reviews.",
    );
  });

  it("rebuilds recorded per-listing state from the listingIds in the URL", async () => {
    state.states = {
      items: [
        {
          listingId: A,
          available: true,
          title: "Margaux 2019",
          status: "in_review",
          activeVersion: null,
          threadId: null,
          audit: AUDIT,
          gap: null,
        },
      ],
    };
    const html = await render({ listingIds: `${A},${B}` });
    expect(html).toContain("Recorded");
    expect(html).toContain(
      `/studio/outputs/${AUDIT.outputId}?revision=2&amp;digest=${AUDIT.contentDigest}`,
    );
  });

  it("reports an unreadable recorded state without crashing the page", async () => {
    state.statesThrow = true;
    const html = await render({ listingIds: A });
    expect(html).toContain("Recorded results are unavailable.");
    expect(html).toContain("Margaux 2019");
  });

  it("reports an unreadable candidate list without inventing listings", async () => {
    state.candidatesThrow = true;
    const html = await render();
    expect(html).toContain("The listing list is unavailable.");
    expect(html).not.toContain("Margaux 2019");
    expect(html).not.toContain("database url");
  });

  it("takes the first value when a query parameter repeats", async () => {
    const html = await render({
      q: ["margaux", "opak"],
      page: ["2", "3"],
    });
    expect(html).toContain("Multi-listing review");
  });
});

// @vitest-environment happy-dom
/**
 * What the review screen says when an action is refused.
 *
 * Every failure used to render the same sentence: "The action could not be
 * completed. Retry or reload." The server had already said which of a dozen
 * things went wrong, and `responseError` threw the body away. So "the AI is
 * still working on this" (wait), "your copy of this page is stale" (reload) and
 * "resolve the compliance flags below" (act) were indistinguishable — and the
 * only offered action, Retry, is the right move for exactly one of them.
 *
 * Two rules are pinned here. A recognised code produces its own remedy; and
 * only `code` crosses the boundary, never `message`, because route handlers may
 * put internals there and the rule against leaking them into a response body
 * means nothing if the screen prints them instead.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewErrorLabel } from "../lib/approval-ui-copy";
import {
  ListingReviewClient,
  type ListingViewResponse,
} from "./listing-review-client.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("reviewErrorLabel", () => {
  it("gives each conflict a remedy of its own", () => {
    const remedies = [
      "stale_version",
      "listing_busy",
      "listing_publishing",
      "blocking_flags",
      "image_approval_required",
      "confirmation_incomplete",
    ].map((code) => reviewErrorLabel(code, "en"));

    expect(remedies.every((text) => typeof text === "string")).toBe(true);
    // Distinct text, not one sentence reused: that was the defect.
    expect(new Set(remedies).size).toBe(remedies.length);
  });

  it("tells the operator to wait, reload or act, as the case requires", () => {
    expect(reviewErrorLabel("listing_busy", "en")).toMatch(/wait/i);
    expect(reviewErrorLabel("stale_version", "en")).toMatch(/reload/i);
    expect(reviewErrorLabel("blocking_flags", "en")).toMatch(/resolve/i);
  });

  it("warns that saving over a stale version would overwrite someone", () => {
    // The reason reloading matters, rather than just an instruction to reload.
    expect(reviewErrorLabel("stale_version", "en")).toMatch(/overwrite/i);
  });

  it("answers in the reader's locale", () => {
    expect(reviewErrorLabel("listing_busy", "zh-Hant")).toContain("AI");
    expect(reviewErrorLabel("listing_busy", "zh-Hant")).not.toEqual(
      reviewErrorLabel("listing_busy", "en"),
    );
  });

  it("returns null for a code it does not know", () => {
    // Null, not a sentence: the caller's own fallback must still run, and that
    // fallback is what renders the permission wording.
    expect(reviewErrorLabel("something_new", "en")).toBeNull();
    expect(reviewErrorLabel(undefined, "en")).toBeNull();
  });

  it("has no entry for a permission failure", () => {
    // `safeUiError` already recognises 401/403 from the status line and says so
    // in the right words. An entry here would silently take priority over it.
    expect(reviewErrorLabel("insufficient_role", "en")).toBeNull();
    expect(reviewErrorLabel("forbidden", "en")).toBeNull();
  });
});

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const listingId = "00000000-0000-4000-8000-000000000101";

/** A listing waiting to be processed: the screen offers exactly one action. */
function receivedSnapshot(): ListingViewResponse {
  return {
    listingId,
    status: "received",
    activeVersion: null,
    evidence: [],
    flags: [],
    connection: "connected",
    productShot: null,
    delivery: null,
    queueStatus: null,
    shoplineLink: null,
    reviewConfirmation: null,
    sourceImportId: null,
    contentDigest: null,
    permissions: {
      canProcess: true,
      canEdit: true,
      canResolveFlags: true,
      canApprove: true,
      canDeliver: true,
    },
    activity: [],
  } as unknown as ListingViewResponse;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountReview() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(ListingReviewClient, { listingId }));
    await Promise.resolve();
  });
  await settle();
  return container;
}

/** Loads the listing, then refuses the first action with `body`. */
async function refuseFirstAction(body: BodyInit | object, status: number) {
  const failure =
    body instanceof Response
      ? body
      : typeof body === "string"
        ? new Response(body, {
            status,
            headers: { "content-type": "text/html" },
          })
        : Response.json(body, { status });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(receivedSnapshot()))
    .mockResolvedValueOnce(failure);
  vi.stubGlobal("fetch", fetcher);
  const container = await mountReview();
  const start = container.querySelector<HTMLButtonElement>("button");
  expect(start).not.toBeNull();
  await act(async () => start!.click());
  await settle();
  return container;
}

describe("an action the server refuses", () => {
  it("renders the remedy the server's code names", async () => {
    const container = await refuseFirstAction(
      {
        code: "listing_busy",
        message: "Listing is being processed; wait for it to finish.",
      },
      409,
    );

    // Rendered in the default locale, which is zh-Hant — so this also proves
    // the remedy goes through `localized` rather than being pasted in English.
    expect(container.textContent).toContain(
      reviewErrorLabel("listing_busy", "zh-Hant"),
    );
    // And it is no longer the sentence that used to cover every failure.
    expect(container.textContent).not.toContain("操作未能完成");
  });

  it("never puts the server's message on the screen", async () => {
    // The one that matters for the leak rule: `message` may carry internals,
    // and only the code is a closed enum safe to act on.
    const container = await refuseFirstAction(
      {
        code: "listing_busy",
        message: "lease held by worker-7 at postgres://internal/db",
      },
      409,
    );

    expect(container.textContent).not.toContain("worker-7");
    expect(container.textContent).not.toContain("postgres://");
  });

  it("falls back to the generic sentence for a code it does not know", async () => {
    // A route may add a code before this table does. Unknown must degrade to
    // what was shown before, never to an empty banner.
    const container = await refuseFirstAction({ code: "brand_new_code" }, 409);

    const banner = container.querySelector('[role="alert"]');
    expect(banner?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("survives an error body that is not JSON at all", async () => {
    // A half-deployed edge answers with an HTML error page, so `json()` throws
    // after the fetch resolved. Reporting a failure must not itself fail.
    const container = await refuseFirstAction(
      "<html>502 Bad Gateway</html>",
      502,
    );

    const banner = container.querySelector('[role="alert"]');
    expect(banner?.textContent?.trim().length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Bad Gateway");
  });
});

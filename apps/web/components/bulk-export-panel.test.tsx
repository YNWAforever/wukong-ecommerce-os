// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BulkExportPanel } from "./bulk-export-panel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ShownListing = { listingId: string; contentDigest: string };

/** Ids paired with an arbitrary-but-stable digest, for tests that do not care what the digest is. */
function listingsOf(
  ids: readonly string[],
  contentDigest = "digest_1",
): ShownListing[] {
  return ids.map((listingId) => ({ listingId, contentDigest }));
}

async function submitExport(
  root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  listings: ShownListing[],
) {
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings,
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe.each([
  [403, { message: "Reviewer access revoked" }],
  [409, { message: "Eligibility changed", rowCount: 0, manifest: [] }],
  [500, { message: "Server failure" }],
  [200, { exportAttemptId: null, rowCount: 0 }],
])("no-attempt response status %i", (status, body) => {
  it("does not present an unsuccessful or malformed response as a completed zero-row export", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await submitExport(root, container, listingsOf(["listing-a"]));

    expect(container.textContent).not.toContain(
      "every requested listing was excluded or unchanged",
    );
    expect(container.textContent).not.toContain("Requested: 1");
    expect(
      container.querySelector("[data-zero-row-export-summary]"),
    ).toBeNull();
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});

it("surfaces the server's attestation_incomplete code as actionable copy, not its raw message", async () => {
  // Defect 2: the route returns `{ code: "attestation_incomplete", message }`
  // (see apps/web/app/api/listings/export/route.ts), but the panel used to
  // discard the whole body on a non-ok, no-attempt response and throw a
  // generic "Unable to generate export (400)" -- so the copy written for
  // this code (apps/web/lib/export-ui-copy.ts's `exportErrors`) never
  // reached a user. The server's `message` must not leak into the UI either.
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        code: "attestation_incomplete",
        message: "UNSAFE SERVER DETAIL should never render",
      },
      { status: 400 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await submitExport(root, container, listingsOf(["listing-a"]));

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(
    "This confirmation does not cover the listings you selected. Confirm again and retry.",
  );
  expect(alert?.textContent).not.toContain("UNSAFE SERVER DETAIL");

  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("keeps exact mixed zero-row counts and member context bound to the submitted response", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      exportAttemptId: null,
      rowCount: 0,
      manifest: [
        {
          listingId: "listing-no-op",
          versionId: "version-no-op",
          outcome: "excluded_no_op",
          reason: "No enrichable fields changed",
        },
        {
          listingId: "listing-stale",
          versionId: "version-stale",
          outcome: "excluded_stale",
          reason: "Imported source is stale",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await submitExport(
    root,
    container,
    listingsOf(["listing-no-op", "listing-stale"]),
  );

  const summary = container.querySelector("[data-zero-row-export-summary]")!;
  expect(summary.textContent).toContain("Requested: 2");
  expect(summary.textContent).toContain("Included: 0");
  expect(summary.textContent).toContain("Excluded: 1");
  expect(summary.textContent).toContain("No-op: 1");
  expect(summary.textContent).toContain("listing-no-op");
  expect(summary.textContent).toContain("version-no-op");
  expect(summary.textContent).toContain("Excluded, no changes");
  expect(summary.textContent).toContain("No enrichable fields changed");
  expect(summary.textContent).toContain("listing-stale");
  expect(summary.textContent).toContain("version-stale");
  expect(summary.textContent).toContain("Excluded, stale source");
  expect(summary.textContent).toContain(
    "Source and review evidence need to be checked again",
  );

  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: listingsOf(["listing-new"]),
        canGenerate: true,
      }),
    ),
  );

  expect(summary.textContent).toContain("Requested: 2");
  expect(summary.textContent).toContain("Excluded: 1");
  expect(summary.textContent).toContain("No-op: 1");
  expect(summary.textContent).toContain("version-stale");
  expect(container.textContent).toContain("1 listing(s) selected");
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("gates generation on permission and explicit freshness, then preserves submitted ids", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      exportAttemptId: null,
      manifest: [
        {
          listingId: "listing-a",
          versionId: null,
          outcome: "excluded_no_op",
          reason: "No changes",
        },
      ],
      rowCount: 0,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: listingsOf(["listing-a"]),
        canGenerate: true,
      }),
    ),
  );
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("Generate Bulk Update XLSX");
  expect(button.disabled).toBe(true);
  const checkbox = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  await act(async () => checkbox.click());
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/listings/export",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        listingIds: ["listing-a"],
        attestation: { listings: listingsOf(["listing-a"]) },
      }),
    }),
  );
  expect(container.textContent).toContain("No enrichable fields changed");
  expect(container.textContent).toContain("No artifact was created");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("sends the attestation the operator was actually shown, not a hardcoded boolean", async () => {
  // The defect this test guards against: the request used to carry one
  // hardcoded `freshnessAttested: true`, made and enforced entirely in the
  // browser. The server can no longer take the browser's word for it -- it
  // needs the exact digests displayed for each selected listing, keyed by
  // listing id, so it can check each one against the current source row.
  const shown: ShownListing[] = [
    { listingId: "listing-a", contentDigest: "digest_1" },
    { listingId: "listing-b", contentDigest: "digest_2" },
  ];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ exportAttemptId: null, rowCount: 0, manifest: [] }),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await submitExport(root, container, shown);

  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, init] = fetcher.mock.calls[0]!;
  const body = JSON.parse(String(init!.body));
  expect(body).toEqual({
    listingIds: ["listing-a", "listing-b"],
    attestation: { listings: shown },
  });
  expect(body).not.toHaveProperty("freshnessAttested");

  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("invalidates freshness when the selected listing IDs change", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: listingsOf(["listing-a"]),
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    false,
  );
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: listingsOf(["listing-a", "listing-b"]),
        canGenerate: true,
      }),
    ),
  );
  expect(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .checked,
  ).toBe(false);
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    true,
  );
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

it("drops the attestation when a digest changes beneath an unchanged selection", async () => {
  // `selectionIdentity` used to join listing ids alone, so when the catalog
  // refreshed and a row's digest changed underneath a selection nobody had
  // touched, the tick survived over content the operator never saw. Folding
  // the digest into the identity means the same listing id, once its
  // content changes, is no longer the selection that was attested to.
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: [{ listingId: "listing-a", contentDigest: "digest_1" }],
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    false,
  );

  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: [{ listingId: "listing-a", contentDigest: "digest_2" }],
        canGenerate: true,
      }),
    ),
  );
  expect(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .checked,
  ).toBe(false);
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    true,
  );
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

it("keeps a POST-created attempt visible and retries only its detail lookup", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        exportAttemptId: "attempt-stable",
        artifactStatus: "pending",
        rowCount: 1,
        manifest: [],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ message: "temporarily unavailable" }, { status: 503 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        attempt: {
          id: "attempt-stable",
          artifactStatus: "ready",
          rowCount: 1,
          specVersion: "v1",
          createdAt: "2026-01-01T00:00:00Z",
        },
        reconciliation: {
          counts: {
            requested: 1,
            included: 1,
            excluded: 0,
            noOp: 0,
            accepted: 0,
            rejected: 0,
            unreported: 1,
          },
          verificationStatus: "unverified",
          members: [],
        },
        capabilities: {
          canGenerateBulkUpdate: true,
          canRecordImportResult: true,
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: listingsOf(["listing-a"]),
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("attempt-stable");
  expect(container.textContent).toContain("Pending");
  const retry = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("Retry attempt details"),
  )!;
  await act(async () => {
    retry.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2]![0]).toBe("/api/listings/export/attempt-stable");
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("shows the stable attempt carried by an artifact error response", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          exportAttemptId: "attempt-failed",
          artifactStatus: "failed",
          message: "Upload verification failed",
        },
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ message: "detail unavailable" }, { status: 503 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listings: listingsOf(["listing-a"]),
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(
    container.querySelector('[data-export-attempt-id="attempt-failed"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("Artifact status: Failed");
  expect(container.textContent).toContain("Retry attempt details");
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

// Exercise the selected locale explicitly; bilingual coverage lives in listing-detail-locale.test.tsx.
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));

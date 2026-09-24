vi.mock("../../../lib/source-readiness", () => ({
  readSourceReadiness: async () => null,
}));
import { describe, expect, it, vi } from "vitest";

import type { ListingStatus } from "@wukong/core";

import { createListListingsHandler } from "./route.js";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../lib/review-confirmation-keys.js";

const zeroCounts: Record<ListingStatus, number> = {
  received: 0,
  processing: 0,
  needs_info: 0,
  in_review: 0,
  approved: 0,
  reopened: 0,
  publishing: 0,
  published: 0,
  publish_failed: 0,
  failed: 0,
};

describe("GET /api/listings", () => {
  it("requires an authenticated workspace session", async () => {
    const handler = createListListingsHandler({
      sessionContext: {
        async resolve() {
          return null;
        },
      },
      getDatabase: () => {
        throw new Error("database should not be opened");
      },
    });

    const response = await handler();

    expect(response.status).toBe(401);
  });

  it("returns recent workspace listings with canonical display fields", async () => {
    const calls: unknown[] = [];
    const updatedAt = new Date("2026-07-18T05:00:00.000Z");
    const handler = createListListingsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "operator",
          };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            calls.push(["forWorkspace", workspaceId]);
            return work({
              reads: {
                async listingPage() {
                  return {
                    ids: ["00000000-0000-4000-8000-000000000101"],
                    totalMatching: 1,
                  };
                },
              },
              listings: {
                async getByIds(ids: string[]) {
                  calls.push(["getByIds", ids]);
                  return [
                    {
                      id: "00000000-0000-4000-8000-000000000101",
                      status: "in_review",
                      target: "shopline",
                      note: "Supplier sheet",
                      updatedAt,
                      activeVersion: {
                        id: "00000000-0000-4000-8000-000000000201",
                        content: {
                          sku: "OPAK-001",
                          title: {
                            en: "Opak Riesling",
                            "zh-Hant": "Opak \u96f7\u53f8\u4ee4",
                          },
                        },
                      },
                      openBlockingFlagCount: 2,
                    },
                  ];
                },
                async countByStatus() {
                  calls.push(["countByStatus"]);
                  return { ...zeroCounts, in_review: 1 };
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          status: "in_review",
          target: "shopline",
          title: "Opak \u96f7\u53f8\u4ee4",
          sku: "OPAK-001",
          updatedAt: "2026-07-18T05:00:00.000Z",
          openBlockingFlagCount: 2,
          reviewContext: null,
          sourceReadiness: null,
        },
      ],
      counts: { ...zeroCounts, in_review: 1 },
      page: 1,
      pageSize: 100,
      totalMatching: 1,
      scope: "workspace",
    });
    expect(calls).toEqual([
      ["forWorkspace", "ws_opak"],
      ["getByIds", ["00000000-0000-4000-8000-000000000101"]],
      ["countByStatus"],
    ]);
  });

  it("includes a workspace-accurate counts field sourced from countByStatus, not the capped item list", async () => {
    const fullCounts: Record<ListingStatus, number> = {
      received: 3,
      processing: 1,
      needs_info: 2,
      in_review: 5,
      approved: 4,
      reopened: 1,
      publishing: 0,
      // Exceeds listRecent's 100-row cap on purpose: if counts were ever
      // derived from `items` instead of a real countByStatus() call, this
      // value could never appear in the response.
      published: 120,
      publish_failed: 1,
      failed: 2,
    };
    const handler = createListListingsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "operator",
          };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              reads: {
                async listingPage() {
                  return {
                    ids: ["00000000-0000-4000-8000-000000000101"],
                    totalMatching: 1,
                  };
                },
              },
              listings: {
                async getByIds() {
                  return [];
                },
                async countByStatus() {
                  return fullCounts;
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();
    const body = (await response.json()) as { counts: unknown };

    expect(body.counts).toEqual(fullCounts);
  });
});

const contextListingId = "00000000-0000-4000-8000-000000000101";
const contextVersionId = "00000000-0000-4000-8000-000000000201";
const completeLedger = {
  listingId: contextListingId,
  versionId: contextVersionId,
  revision: 0,
  fieldConfirmations: Object.fromEntries(
    CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
  ),
  negativeConfirmations: Object.fromEntries(
    CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
  ),
  sourceImportId: "import_1",
  rowDigest: "digest_1",
};
const importedLink = {
  origin: "import",
  sourceImportId: "import_1",
  contentDigest: "digest_1",
};

async function collectionReviewContext(
  ledger: Record<string, unknown> | null = completeLedger,
  link: Record<string, unknown> | null = importedLink,
  hasVersion = true,
) {
  const reads: string[] = [];
  const handler = createListListingsHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role: "reviewer" };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          expect(workspaceId).toBe("ws_opak");
          return work({
            reads: {
              async listingPage() {
                return {
                  ids: ["00000000-0000-4000-8000-000000000101"],
                  totalMatching: 1,
                };
              },
            },
            listings: {
              async getByIds() {
                return [
                  {
                    id: contextListingId,
                    status: "in_review",
                    target: "shopline",
                    note: null,
                    updatedAt: new Date("2026-09-05T00:00:00Z"),
                    activeVersion: hasVersion
                      ? {
                          id: contextVersionId,
                          content: {
                            sku: "SYNTHETIC",
                            title: { en: "Synthetic product" },
                          },
                        }
                      : null,
                    openBlockingFlagCount: 0,
                  },
                ];
              },
              async countByStatus() {
                return { ...zeroCounts, in_review: 1 };
              },
            },
            reviewConfirmations: {
              async getByVersionId(versionId: string) {
                reads.push("ledger");
                expect(versionId).toBe(contextVersionId);
                return ledger;
              },
            },
            platformProducts: {
              async getByListingId(listingId: string) {
                reads.push("link");
                expect(listingId).toBe(contextListingId);
                return link;
              },
            },
          });
        },
      }) as never,
  });
  const response = await handler();
  expect(response.status).toBe(200);
  const body = await response.json();
  return { context: body.items[0].reviewContext, reads };
}

describe("GET /api/listings review context", () => {
  it("exposes the observed ledger revision including zero and bound imported source", async () => {
    expect((await collectionReviewContext()).context).toEqual({
      expectedVersionId: contextVersionId,
      confirmationLedgerRevision: 0,
      expectedSourceImportId: "import_1",
      expectedRowDigest: "digest_1",
    });
  });

  it.each([
    ["unlinked", null],
    [
      "created origin",
      { origin: "created", sourceImportId: null, contentDigest: null },
    ],
  ])("omits import context for a %s listing", async (_name, link) => {
    expect(
      (
        await collectionReviewContext(
          {
            ...completeLedger,
            sourceImportId: null,
            rowDigest: null,
          },
          link,
        )
      ).context,
    ).toEqual({
      expectedVersionId: contextVersionId,
      confirmationLedgerRevision: 0,
    });
  });

  it.each([
    ["missing", null],
    ["incomplete fields", { ...completeLedger, fieldConfirmations: {} }],
    [
      "incomplete negative conditions",
      { ...completeLedger, negativeConfirmations: {} },
    ],
    ["another listing", { ...completeLedger, listingId: "another_listing" }],
    ["another version", { ...completeLedger, versionId: "another_version" }],
    ["stale import", { ...completeLedger, sourceImportId: "old_import" }],
    ["stale row", { ...completeLedger, rowDigest: "old_digest" }],
    ["missing import", { ...completeLedger, sourceImportId: null }],
    ["missing row", { ...completeLedger, rowDigest: null }],
  ])("withholds context for a %s ledger", async (_name, ledger) => {
    expect((await collectionReviewContext(ledger)).context).toBeNull();
  });

  it.each([
    ["missing import", { ...importedLink, sourceImportId: null }],
    ["missing row", { ...importedLink, contentDigest: null }],
  ])("withholds context for an imported link with %s", async (_name, link) => {
    expect(
      (await collectionReviewContext(completeLedger, link)).context,
    ).toBeNull();
  });

  it.each([
    ["missing link", null],
    [
      "created origin",
      { origin: "created", sourceImportId: null, contentDigest: null },
    ],
  ])(
    "withholds imported review context after the source becomes %s",
    async (_name, link) => {
      expect(
        (await collectionReviewContext(completeLedger, link)).context,
      ).toBeNull();
    },
  );

  it.each([
    ["import ID only", { ...completeLedger, rowDigest: null }],
    ["row digest only", { ...completeLedger, sourceImportId: null }],
  ])(
    "does not discard a remaining %s binding when the import link disappears",
    async (_name, ledger) => {
      expect((await collectionReviewContext(ledger, null)).context).toBeNull();
    },
  );

  it("does not read confirmation or source context without an active version", async () => {
    expect(
      await collectionReviewContext(completeLedger, importedLink, false),
    ).toEqual({
      context: null,
      reads: [],
    });
  });
});

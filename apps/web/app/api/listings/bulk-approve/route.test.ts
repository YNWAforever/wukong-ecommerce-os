import { describe, expect, it, vi } from "vitest";

import { approveOne } from "../../../../lib/listing-approval";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../../lib/review-confirmation-keys";
import { createBulkApproveHandler } from "./route.js";

const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};
const id1 = "00000000-0000-4000-8000-000000000101";
const id2 = "00000000-0000-4000-8000-000000000102";
const id3 = "00000000-0000-4000-8000-000000000103";
const fields = Object.fromEntries(
  CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
);
const negatives = Object.fromEntries(
  CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
);

function item(listingId: string, overrides: Record<string, unknown> = {}) {
  return {
    listingId,
    expectedVersionId: listingId + "-v1",
    confirmationLedgerRevision: 0,
    ...overrides,
  };
}
function request(body: unknown) {
  return new Request("http://localhost/api/listings/bulk-approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function confirmed(listingId: string) {
  return {
    listingId,
    versionId: listingId + "-v1",
    revision: 0,
    fieldConfirmations: { ...fields },
    negativeConfirmations: { ...negatives },
    sourceImportId: null as string | null,
    rowDigest: null as string | null,
  };
}
type Row = {
  versionId?: string;
  draftVersionId?: string;
  missing?: boolean;
  flagged?: boolean;
  broken?: boolean;
  confirmation?: ReturnType<typeof confirmed> | null;
  link?: {
    origin: "import" | "created";
    sourceImportId: string | null;
    contentDigest: string | null;
  } | null;
};
function makeHandler(
  options: { role?: string; rows?: Record<string, Row> } = {},
) {
  const committed: string[] = [];
  const audited: unknown[] = [];
  const entered: string[] = [];
  const domainApproval = vi.fn();
  const repositoriesFor = (pending: string[] = [], events: unknown[] = []) => ({
    listings: {
      async getReviewSnapshot(id: string) {
        const row = options.rows?.[id];
        if (row?.missing) return null;
        return {
          listing: {
            id,
            target: "shopline",
            status: "in_review",
            activeVersionId:
              row?.draftVersionId ?? row?.versionId ?? id + "-v1",
          },
          activeVersion: {
            id: row?.versionId ?? id + "-v1",
            sequence: 1,
            content: { sku: "SYNTHETIC", imageAssetIds: [] },
          },
          evidence: [],
          flags: row?.flagged
            ? [
                {
                  id: "flag_1",
                  field: "description",
                  rule: "health_claim",
                  severity: "blocking",
                  status: "open",
                  resolutionReason: null,
                },
              ]
            : [],
        };
      },
      async approve(id: string) {
        if (options.rows?.[id]?.broken)
          throw new Error("postgres://internal-password@private-host failure");
        pending.push(id);
      },
    },
    reviewConfirmations: {
      async getByVersionId(versionId: string) {
        const id = versionId.replace(/-v[0-9]+$/, "");
        const row = options.rows?.[id];
        return row?.confirmation === undefined
          ? confirmed(id)
          : row.confirmation;
      },
    },
    platformProducts: {
      async getByListingId(id: string) {
        return options.rows?.[id]?.link ?? null;
      },
    },
    audit: {
      async write(event: unknown) {
        events.push(event);
      },
    },
  });
  const handler = createBulkApproveHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "reviewer" } as never;
      },
    },
    getDatabase: () => ({
      async forWorkspace<T>(
        workspaceId: string,
        work: (repos: any) => Promise<T>,
      ) {
        entered.push(workspaceId);
        const pending: string[] = [],
          events: unknown[] = [];
        const result = await work(repositoriesFor(pending, events));
        committed.push(...pending);
        audited.push(...events);
        return result;
      },
    }),
    approve: async (versionId, flags, auditContext, audit) => {
      domainApproval(versionId, auditContext);
      if (
        flags.some(
          (flag) => flag.severity === "blocking" && flag.status === "open",
        )
      ) {
        throw new Error(
          "Blocking compliance flags must be resolved before approval",
        );
      }
      await audit.write({
        ...auditContext,
        action: "listing.approved",
        metadata: { versionId },
      });
      return { versionId, status: "approved" as const };
    },
  });
  return {
    handler,
    committed,
    audited,
    entered,
    domainApproval,
    repositoriesFor,
  };
}
const imported = {
  origin: "import" as const,
  sourceImportId: "import-1",
  contentDigest: "digest-1",
};
const importedConfirmation = () => ({
  ...confirmed(id1),
  sourceImportId: "import-1",
  rowDigest: "digest-1",
});
const importedItem = (overrides = {}) =>
  item(id1, {
    expectedSourceImportId: "import-1",
    expectedRowDigest: "digest-1",
    ...overrides,
  });

describe("POST /api/listings/bulk-approve", () => {
  it.each([
    ["missing confirmations", { confirmation: null }],
    [
      "changed confirmations",
      {
        confirmation: {
          ...confirmed(id1),
          revision: 2,
          fieldConfirmations: {},
        },
      },
    ],
    [
      "refreshed imported source",
      {
        link: {
          ...imported,
          sourceImportId: "import-2",
          contentDigest: "digest-2",
        },
        confirmation: importedConfirmation(),
      },
    ],
  ] as const)("rejects legacy ID-only approval with %s", async (_name, row) => {
    const { handler, committed, entered } = makeHandler({
      rows: { [id1]: row },
    });
    const response = await handler(request({ listingIds: [id1] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "review_context_required",
    });
    expect(committed).toEqual([]);
    expect(entered).toEqual([]);
  });

  it.each(["viewer", "operator"])(
    "rejects %s before data access",
    async (role) => {
      const { handler, entered } = makeHandler({ role });
      expect((await handler(request({ items: [item(id1)] }))).status).toBe(403);
      expect(entered).toEqual([]);
    },
  );

  it.each([
    [],
    [item(id1), item(id1)],
    Array.from({ length: 51 }, (_, i) =>
      item("00000000-0000-4000-8000-" + String(i).padStart(12, "0")),
    ),
  ])("rejects invalid batch bounds or duplicate listing IDs", async (items) => {
    const { handler, entered } = makeHandler();
    expect((await handler(request({ items }))).status).toBe(400);
    expect(entered).toEqual([]);
  });

  it.each([
    { listingId: id1 },
    item(id1, { expectedVersionId: "" }),
    item(id1, { confirmationLedgerRevision: undefined }),
    item(id1, { confirmationLedgerRevision: -1 }),
    item(id1, { confirmationLedgerRevision: 0.5 }),
    item(id1, { expectedRowDigest: "" }),
  ])("rejects incomplete or malformed observed context", async (entry) => {
    const { handler, committed } = makeHandler();
    expect((await handler(request({ items: [entry] }))).status).toBe(400);
    expect(committed).toEqual([]);
  });

  it("rejects duplicate UUIDs with different letter case before transactions", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { handler, entered } = makeHandler();
    const response = await handler(
      request({ items: [item(id), item(id.toUpperCase())] }),
    );
    expect(response.status).toBe(400);
    expect(entered).toEqual([]);
  });

  it("accepts exactly 50 distinct fully reviewed items", async () => {
    const { handler, committed, entered } = makeHandler();
    const items = Array.from({ length: 50 }, (_, i) =>
      item("00000000-0000-4000-8000-" + String(i).padStart(12, "0")),
    );
    const response = await handler(request({ items }));
    expect(await response.json()).toMatchObject({ approved: 50, failed: 0 });
    expect(committed).toHaveLength(50);
    expect(entered).toEqual(Array(50).fill(context.workspaceId));
  });

  it.each([
    [
      "import link removed",
      { confirmation: importedConfirmation() },
      importedItem(),
      "source_origin_changed",
    ],
    [
      "import origin overwritten",
      {
        confirmation: importedConfirmation(),
        link: { origin: "created", sourceImportId: null, contentDigest: null },
      },
      importedItem(),
      "source_origin_changed",
    ],
    [
      "imported checklist without client source",
      { confirmation: importedConfirmation() },
      item(id1),
      "source_origin_changed",
    ],
    [
      "observed import without stored binding",
      {},
      importedItem(),
      "source_origin_changed",
    ],
    [
      "missing checklist",
      { confirmation: null },
      item(id1),
      "confirmation_ledger_stale",
    ],
    [
      "changed revision",
      { confirmation: { ...confirmed(id1), revision: 1 } },
      item(id1),
      "confirmation_ledger_stale",
    ],
    [
      "missing field",
      { confirmation: { ...confirmed(id1), fieldConfirmations: {} } },
      item(id1),
      "confirmation_incomplete",
    ],
    [
      "missing negative",
      { confirmation: { ...confirmed(id1), negativeConfirmations: {} } },
      item(id1),
      "confirmation_incomplete",
    ],
    [
      "changed version",
      { versionId: id1 + "-v2" },
      item(id1),
      "version_conflict",
    ],
    [
      "mixed snapshot",
      { draftVersionId: id1 + "-v2" },
      item(id1),
      "version_conflict",
    ],
    [
      "new import applicability",
      { link: imported },
      item(id1),
      "source_freshness_required",
    ],
    [
      "refreshed import",
      {
        link: { ...imported, sourceImportId: "import-2" },
        confirmation: importedConfirmation(),
      },
      importedItem(),
      "source_import_mismatch",
    ],
    [
      "changed row digest",
      {
        link: { ...imported, contentDigest: "digest-2" },
        confirmation: importedConfirmation(),
      },
      importedItem(),
      "row_digest_mismatch",
    ],
    [
      "checklist on old source",
      {
        link: imported,
        confirmation: { ...importedConfirmation(), rowDigest: "old-digest" },
      },
      importedItem(),
      "confirmation_source_stale",
    ],
    ["foreign listing", { missing: true }, item(id1), "listing_not_found"],
    ["blocking flag", { flagged: true }, item(id1), "blocking_flags"],
  ] as const)(
    "isolates %s while approving its valid neighbor",
    async (_name, row, entry, code) => {
      const { handler, committed, entered } = makeHandler({
        rows: { [id1]: row },
      });
      const response = await handler(
        request({
          items: [entry, item(id2)],
          workspaceId: "foreign-workspace",
          actorId: "forged",
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        approved: 1,
        failed: 1,
        results: [
          { listingId: id1, ok: false, code },
          { listingId: id2, ok: true, versionId: id2 + "-v1" },
        ],
      });
      expect(committed).toEqual([id2]);
      expect(entered).toEqual([context.workspaceId, context.workspaceId]);
    },
  );

  it("approves matching imported and created contexts using session identity and existing audit", async () => {
    const { handler, committed, audited, domainApproval } = makeHandler({
      rows: {
        [id1]: { link: imported, confirmation: importedConfirmation() },
        [id2]: {
          link: {
            origin: "created",
            sourceImportId: null,
            contentDigest: null,
          },
        },
      },
    });
    expect(
      await (
        await handler(
          request({
            items: [importedItem(), item(id2), item(id3)],
            actorId: "forged",
            workspaceId: "foreign",
          }),
        )
      ).json(),
    ).toMatchObject({ approved: 3, failed: 0 });
    expect(committed).toEqual([id1, id2, id3]);
    expect(audited).toHaveLength(3);
    expect(domainApproval).toHaveBeenCalledWith(id1 + "-v1", {
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      entityId: id1,
    });
  });

  it("rolls back a failed item's audit and returns safe diagnostics while neighbors commit", async () => {
    const { handler, committed, audited } = makeHandler({
      rows: { [id2]: { broken: true } },
    });
    const response = await handler(
      request({ items: [item(id1), item(id2), item(id3)] }),
    );
    const body = await response.json();
    expect(body).toMatchObject({
      approved: 2,
      failed: 1,
      results: [
        { listingId: id1, ok: true },
        {
          listingId: id2,
          ok: false,
          code: "unknown_error",
          message: "Unable to approve this listing. Please try again.",
        },
        { listingId: id3, ok: true },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/postgres|password|private-host/);
    expect(committed).toEqual([id1, id3]);
    expect(audited).toHaveLength(2);
  });

  it("requires context even for callers directly invoking the shared service", async () => {
    const { repositoriesFor } = makeHandler();
    await expect(
      approveOne(
        id1,
        { ...context, entityId: id1 },
        repositoriesFor() as never,
        {} as never,
      ),
    ).rejects.toMatchObject({ status: 400, code: "review_context_required" });
  });
});

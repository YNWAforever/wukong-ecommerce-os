import { describe, expect, it } from "vitest";

import { createBulkApproveHandler } from "./route.js";

const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

function request(listingIds: string[]) {
  return new Request("http://localhost/api/listings/bulk-approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ listingIds }),
  });
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin";
    flaggedIds?: string[];
  } = {},
) {
  const approved: string[] = [];
  const flagged = new Set(options.flaggedIds ?? []);
  const handler = createBulkApproveHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "reviewer" };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: any) => Promise<T>,
        ) {
          return work({
            listings: {
              async getReviewSnapshot(id: string) {
                return {
                  listing: {
                    id,
                    target: "shopline",
                    status: "in_review",
                  },
                  activeVersion: {
                    id: `${id}-v1`,
                    sequence: 1,
                    content: { sku: "OPAK-001", imageAssetIds: [] },
                  },
                  evidence: [],
                  flags: flagged.has(id)
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
                approved.push(id);
              },
            },
            audit: { async write() {} },
          });
        },
      }) as never,
    approve: async (versionId: string, flags: any[]) => {
      const open = flags.some(
        (flag) => flag.severity === "blocking" && flag.status === "open",
      );
      if (open)
        throw new Error(
          "Blocking compliance flags must be resolved before approval",
        );
      return { versionId, status: "approved" as const };
    },
  });
  return { handler, approved };
}

const id1 = "00000000-0000-4000-8000-000000000101";
const id2 = "00000000-0000-4000-8000-000000000102";
const id3 = "00000000-0000-4000-8000-000000000103";

describe("POST /api/listings/bulk-approve", () => {
  it("rejects a viewer", async () => {
    const { handler } = makeHandler({ role: "viewer" });
    const response = await handler(request([id1]));
    expect(response.status).toBe(403);
  });

  it("rejects an empty list", async () => {
    const { handler } = makeHandler();
    const response = await handler(request([]));
    expect(response.status).toBe(400);
  });

  it("rejects more than 50 ids", async () => {
    const { handler } = makeHandler();
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const response = await handler(request(ids));
    expect(response.status).toBe(400);
  });

  it("approves every eligible listing and reports each flagged one as failed, in one 200", async () => {
    const { handler, approved } = makeHandler({ flaggedIds: [id2] });
    const response = await handler(request([id1, id2, id3]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.approved).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results).toEqual([
      { listingId: id1, ok: true, versionId: `${id1}-v1` },
      {
        listingId: id2,
        ok: false,
        code: "blocking_flags",
        message: expect.any(String),
      },
      { listingId: id3, ok: true, versionId: `${id3}-v1` },
    ]);
    expect(approved).toEqual([id1, id3]);
  });
});

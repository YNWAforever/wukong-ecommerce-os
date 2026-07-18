import { describe, expect, it } from "vitest";

import { createListingViewHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin",
  hasConnection = false,
) {
  return createListingViewHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          return work({
            listings: {
              async getReviewSnapshot() {
                return {
                  listing: { id: listingId, status: "in_review" },
                  activeVersion: {
                    id: "version_1",
                    content: { sku: "OPAK-1" },
                  },
                  evidence: [],
                  flags: [],
                };
              },
            },
            publishJobs: {
              async getByIdempotencyKey() {
                return null;
              },
            },
            shoplineConnections: {
              async getDefault() {
                return hasConnection ? { id: "connection_1" } : null;
              },
            },
          });
        },
      }) as never,
  });
}

describe("GET /api/listings/[id]", () => {
  it.each([
    [
      "viewer",
      {
        canEdit: false,
        canResolveFlags: false,
        canApprove: false,
        canDeliver: false,
      },
    ],
    [
      "operator",
      {
        canEdit: true,
        canResolveFlags: true,
        canApprove: false,
        canDeliver: false,
      },
    ],
    [
      "reviewer",
      {
        canEdit: true,
        canResolveFlags: true,
        canApprove: true,
        canDeliver: true,
      },
    ],
    [
      "admin",
      {
        canEdit: true,
        canResolveFlags: true,
        canApprove: true,
        canDeliver: true,
      },
    ],
  ] as const)(
    "returns server-derived permissions for %s",
    async (role, permissions) => {
      const response = await handlerFor(role)(new Request("http://localhost"), {
        params: Promise.resolve({ id: listingId }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ permissions });
    },
  );
});

it("derives connected status from the workspace SHOPLINE connection", async () => {
  const response = await handlerFor("reviewer", true)(
    new Request("http://localhost"),
    { params: Promise.resolve({ id: listingId }) },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ connection: "connected" });
});

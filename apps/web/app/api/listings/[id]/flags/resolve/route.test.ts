import { describe, expect, it } from "vitest";

import { createResolveComplianceFlagHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "operator_1",
  role: "operator" as const,
};
const openFlag = {
  id: "description:health_claim:0",
  field: "description",
  rule: "health_claim" as const,
  severity: "blocking" as const,
  status: "open" as const,
  resolutionReason: null,
};

function request(body: Record<string, unknown>) {
  return new Request(
    `http://localhost/api/listings/${listingId}/flags/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function routeContext() {
  return { params: Promise.resolve({ id: listingId }) };
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin";
    activeVersionId?: string | null;
    flags?: Array<typeof openFlag>;
  } = {},
) {
  const calls: unknown[] = [];
  const flags = options.flags ?? [openFlag];
  const handler = createResolveComplianceFlagHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "operator" };
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
            listings: {
              async getReviewSnapshot(id: string) {
                calls.push(["getReviewSnapshot", id]);
                return {
                  listing: { id },
                  activeVersion:
                    options.activeVersionId === null
                      ? null
                      : { id: options.activeVersionId ?? versionId },
                  flags,
                };
              },
              async replaceFlags(id: string, nextFlags: unknown[]) {
                calls.push(["replaceFlags", id, nextFlags]);
              },
            },
            audit: {
              async write(event: unknown) {
                calls.push(["audit", event]);
              },
            },
          });
        },
      }) as never,
  });
  return { handler, calls };
}

describe("POST /api/listings/[id]/flags/resolve", () => {
  it("rejects a viewer before opening a workspace transaction", async () => {
    const { handler, calls } = makeHandler({ role: "viewer" });
    const response = await handler(
      request({
        versionId,
        flagId: openFlag.id,
        reason: "Verified by reviewer",
      }),
      routeContext(),
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects stale versions and unknown flags", async () => {
    const stale = makeHandler({ activeVersionId: versionId });
    const staleResponse = await stale.handler(
      request({
        versionId: "00000000-0000-4000-8000-000000000999",
        flagId: openFlag.id,
        reason: "Verified by reviewer",
      }),
      routeContext(),
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ code: "stale_version" });

    const missing = makeHandler({ flags: [] });
    const missingResponse = await missing.handler(
      request({
        versionId,
        flagId: openFlag.id,
        reason: "Verified by reviewer",
      }),
      routeContext(),
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      code: "flag_not_found",
    });
  });

  it("requires a meaningful resolution reason", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      request({ versionId, flagId: openFlag.id, reason: "too short" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("audits the resolution and persists the complete updated flag set", async () => {
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        flagId: openFlag.id,
        reason: "Source wording was removed by the reviewer.",
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listingId,
      versionId,
      flag: {
        ...openFlag,
        status: "resolved",
        resolutionReason: "Source wording was removed by the reviewer.",
      },
    });
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        workspaceId: "ws_opak",
        actorId: "operator_1",
        entityId: listingId,
        action: "compliance.flag_resolved",
      }),
    ]);
    expect(calls).toContainEqual([
      "replaceFlags",
      versionId,
      [
        expect.objectContaining({
          id: openFlag.id,
          status: "resolved",
          resolutionReason: "Source wording was removed by the reviewer.",
        }),
      ],
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { createApproveListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = { workspaceId: "ws_opak", actorId: "reviewer_1", role: "reviewer" as const };

const request = () => new Request(`http://localhost/api/listings/${listingId}/approve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ requestedStatus: "published", workspaceId: "ws_other", actorId: "attacker" }),
});

function routeContext() {
  return { params: Promise.resolve({ id: listingId }) };
}

function makeHandler(options: {
  role?: "viewer" | "operator" | "reviewer" | "admin";
  status?: "in_review" | "approved" | "published" | "reopened";
  flags?: Array<{ id: string; field: string; rule: "health_claim"; severity: "blocking"; status: "open" | "resolved"; resolutionReason: string | null }>;
}) {
  const calls: unknown[] = [];
  const handler = createApproveListingHandler({
    sessionContext: { async resolve() { return { ...context, role: options.role ?? "reviewer" }; } },
    getDatabase: () => ({
      async forWorkspace<T>(_workspaceId: string, work: (repos: any) => Promise<T>) {
        return work({
          listings: {
            async requireForPublish(id: string) {
              calls.push(["requireForPublish", id]);
              return {
                id,
                target: "shopline",
                status: options.status ?? "in_review",
                activeVersion: { id: versionId, sequence: 3, content: { sku: "OPAK-001" } },
                flags: options.flags ?? [],
              };
            },
            async approve(id: string, version: string, auditContext: unknown, _audit: unknown) {
              calls.push(["approve", id, version, auditContext]);
            },
          },
          audit: { async write(event: unknown) { calls.push(["audit", event]); } },
        });
      },
    }) as never,
    approve: async (version: string, flags: any[], auditContext: any, audit: any) => {
      calls.push(["domainApprove", version, flags, auditContext]);
      const open = flags.some((flag) => flag.severity === "blocking" && flag.status === "open");
      if (open) throw new Error("Blocking compliance flags must be resolved before approval");
      await audit.write({ ...auditContext, action: "listing.approved", metadata: { versionId: version } });
      return { versionId: version, status: "approved" as const };
    },
  });
  return { handler, calls };
}

describe("POST /api/listings/[id]/approve", () => {
  it("rejects a viewer before loading any listing", async () => {
    const { handler, calls } = makeHandler({ role: "viewer" });
    const response = await handler(request(), routeContext());
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("returns 422 for an unresolved blocking flag", async () => {
    const { handler } = makeHandler({ flags: [{ id: "flag_1", field: "description", rule: "health_claim", severity: "blocking", status: "open", resolutionReason: null }] });
    const response = await handler(request(), routeContext());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "blocking_flags" });
  });

  it("approves the server-resolved active version and ignores requested identity/status", async () => {
    const { handler, calls } = makeHandler({});
    const response = await handler(request(), routeContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ listingId, versionId, status: "approved" });
    expect(calls).toContainEqual(["domainApprove", versionId, [], expect.objectContaining({ workspaceId: "ws_opak", actorId: "reviewer_1", entityId: listingId })]);
    expect(calls).toContainEqual(["approve", listingId, versionId, expect.objectContaining({ workspaceId: "ws_opak", actorId: "reviewer_1" })]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { createInviteRevokeHandler } from "./route.js";

function harness(role: string) {
  const revokeInvite = vi.fn(async () => {});
  const auditWrite = vi.fn(async () => {});
  const handler = createInviteRevokeHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({
          memberships: { revokeInvite },
          audit: { write: auditWrite },
        }),
    }),
  } as any);
  return { handler, revokeInvite, auditWrite };
}

function makeContext(inviteId: string) {
  return { params: Promise.resolve({ inviteId }) };
}

describe("DELETE /api/workspace/invites/[inviteId]", () => {
  it("rejects a sub-admin role", async () => {
    const { handler, revokeInvite } = harness("reviewer");
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      makeContext("inv1"),
    );
    expect(response.status).toBe(403);
    expect(revokeInvite).not.toHaveBeenCalled();
  });

  it("revokes the invite for an admin", async () => {
    const { handler, revokeInvite, auditWrite } = harness("admin");
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      makeContext("inv1"),
    );
    expect(response.status).toBe(200);
    expect(revokeInvite).toHaveBeenCalledWith("inv1");
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        actorId: "u1",
        entityId: "inv1",
        action: "workspace.invite_revoked",
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import { createMembersListHandler } from "./route.js";

function harness(role: string) {
  const listForWorkspace = vi.fn(async () => [
    { userId: "u1", email: "admin@opak.test", role: "admin", createdAt: new Date("2026-01-01") },
  ]);
  const listInvites = vi.fn(async () => [
    { id: "inv1", email: "new@opak.test", role: "operator", createdAt: new Date("2026-01-02") },
  ]);
  const handler = createMembersListHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({ memberships: { listForWorkspace, listInvites } }),
    }),
  } as any);
  return { handler, listForWorkspace, listInvites };
}

describe("GET /api/workspace/members", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(403);
  });

  it("returns members and invites for an admin", async () => {
    const { handler } = harness("admin");
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.members).toHaveLength(1);
    expect(body.invites).toHaveLength(1);
  });

  it("allows an owner too", async () => {
    const { handler } = harness("owner");
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(200);
  });
});

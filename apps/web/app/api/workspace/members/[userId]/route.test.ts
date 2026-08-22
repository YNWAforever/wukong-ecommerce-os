import { describe, expect, it, vi } from "vitest";

import { MembershipGuardViolation } from "@wukong/db";

import { createMemberHandler } from "./route.js";

function harness(
  role: string,
  overrides: { updateRole?: any; remove?: any } = {},
) {
  const updateRole = overrides.updateRole ?? vi.fn(async () => undefined);
  const remove = overrides.remove ?? vi.fn(async () => undefined);
  const auditWrite = vi.fn(async () => undefined);
  const handler = createMemberHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "acting_user", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({
          memberships: { updateRole, remove },
          audit: { write: auditWrite },
        }),
    }),
  } as any);
  return { handler, updateRole, remove, auditWrite };
}

const context = { params: Promise.resolve({ userId: "target_user" }) };

describe("PATCH /api/workspace/members/[userId]", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ role: "operator" }),
      }),
      context,
    );
    expect(response.status).toBe(403);
  });

  it("changes the target's role for an admin", async () => {
    const { handler, updateRole, auditWrite } = harness("admin");
    const response = await handler(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ role: "operator" }),
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(updateRole).toHaveBeenCalledWith(
      "acting_user",
      "target_user",
      "operator",
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.member_role_changed" }),
    );
  });

  it("maps a MembershipGuardViolation to 409", async () => {
    const { handler } = harness("admin", {
      updateRole: vi.fn(async () => {
        throw new MembershipGuardViolation("last_admin");
      }),
    });
    const response = await handler(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ role: "operator" }),
      }),
      context,
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("last_admin");
  });

  it("rejects an invalid role value with 400", async () => {
    const { handler } = harness("admin");
    const response = await handler(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ role: "owner" }),
      }),
      context,
    );
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/workspace/members/[userId]", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context,
    );
    expect(response.status).toBe(403);
  });

  it("removes the target for an admin", async () => {
    const { handler, remove, auditWrite } = harness("admin");
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("acting_user", "target_user");
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.member_removed" }),
    );
  });

  it("maps a MembershipGuardViolation to 409", async () => {
    const { handler } = harness("admin", {
      remove: vi.fn(async () => {
        throw new MembershipGuardViolation("self_action");
      }),
    });
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context,
    );
    expect(response.status).toBe(409);
  });
});

describe("unsupported methods on /api/workspace/members/[userId]", () => {
  it("rejects a GET with 405 instead of silently running role-change handling", async () => {
    const { handler, updateRole, remove } = harness("admin");
    const response = await handler(
      new Request("http://localhost", { method: "GET" }),
      context,
    );
    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body.code).toBe("method_not_allowed");
    expect(updateRole).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

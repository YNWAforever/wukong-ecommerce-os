import { describe, expect, it, vi } from "vitest";

import { MembershipGuardViolation } from "@wukong/db";

import { createMemberInviteHandler } from "./route.js";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/workspace/members/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function harness(
  role: string,
  options: {
    createInvite?: ReturnType<typeof vi.fn>;
    requestEnrollment?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const createInvite =
    options.createInvite ??
    vi.fn(async (email: string, inviteRole: string) => ({
      id: "inv1",
      email,
      role: inviteRole,
      createdAt: new Date("2026-01-01"),
    }));
  const requestEnrollment =
    options.requestEnrollment ?? vi.fn(async () => ({ accepted: true }));
  const auditWrite = vi.fn(async () => {});
  const handler = createMemberInviteHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({
          memberships: { createInvite },
          audit: { write: auditWrite },
        }),
    }),
    requestEnrollment,
  } as any);
  return { handler, createInvite, auditWrite, requestEnrollment };
}

describe("POST /api/workspace/members/invite", () => {
  it("rejects a sub-admin role", async () => {
    const { handler, createInvite, requestEnrollment } = harness("reviewer");
    const response = await handler(
      makeRequest({ email: "new@opak.test", role: "operator" }),
    );
    expect(response.status).toBe(403);
    expect(createInvite).not.toHaveBeenCalled();
    expect(requestEnrollment).not.toHaveBeenCalled();
  });

  it("creates the invite for an admin", async () => {
    const { handler, createInvite, auditWrite } = harness("admin");
    const response = await handler(
      makeRequest({ email: "new@opak.test", role: "operator" }),
    );
    expect(response.status).toBe(200);
    expect(createInvite).toHaveBeenCalledWith("new@opak.test", "operator");
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        actorId: "u1",
        action: "workspace.member_invited",
      }),
    );
  });

  it("rejects a body missing email with 400", async () => {
    const { handler } = harness("admin");
    const response = await handler(makeRequest({ role: "operator" }));
    expect(response.status).toBe(400);
  });

  it("rejects a body with an invalid role with 400", async () => {
    const { handler } = harness("admin");
    const response = await handler(
      makeRequest({ email: "new@opak.test", role: "superadmin" }),
    );
    expect(response.status).toBe(400);
  });

  it("maps a MembershipGuardViolation to a 409", async () => {
    const createInvite = vi.fn(async () => {
      throw new MembershipGuardViolation("already_member");
    });
    const { handler } = harness("admin", { createInvite });
    const response = await handler(
      makeRequest({ email: "new@opak.test", role: "operator" }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("already_member");
  });

  it("sends a real enrollment email after creating the invite", async () => {
    const { handler, requestEnrollment } = harness("admin");
    const response = await handler(
      makeRequest({ email: "new@opak.test", role: "operator" }),
    );
    expect(response.status).toBe(200);
    expect(requestEnrollment).toHaveBeenCalledWith({ email: "new@opak.test" });
  });

  it("still returns success when the enrollment email fails to send", async () => {
    const requestEnrollment = vi.fn(async () => {
      throw new Error("smtp unreachable");
    });
    const { handler } = harness("admin", { requestEnrollment });
    const response = await handler(
      makeRequest({ email: "new@opak.test", role: "operator" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.email).toBe("new@opak.test");
  });
});

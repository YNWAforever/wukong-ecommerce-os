import { describe, expect, it } from "vitest";

import { requireWorkspaceRole, sessionContext, type MembershipRepository } from "./session-context";

describe("session context", () => {
  const memberships: MembershipRepository = {
    findActiveByUserId: async (userId) =>
      userId === "user_opak_operator"
        ? { workspaceId: "ws_opak", actorId: userId, role: "operator" }
        : null,
  };

  it("derives workspace and actor from membership rather than request input", async () => {
    await expect(
      sessionContext(
        { user: { id: "user_opak_operator", email: "operator@opak.example" }, workspaceId: "attacker" },
        memberships,
      ),
    ).resolves.toEqual({
      workspaceId: "ws_opak",
      actorId: "user_opak_operator",
      role: "operator",
    });
  });

  it("rejects sessions without an active membership", async () => {
    await expect(
      sessionContext({ user: { id: "unknown", email: "unknown@example.com" } }, memberships),
    ).resolves.toBeNull();
  });

  it("enforces viewer < operator < reviewer < admin", () => {
    expect(requireWorkspaceRole("operator", "viewer")).toBe(false);
    expect(requireWorkspaceRole("operator", "operator")).toBe(true);
    expect(requireWorkspaceRole("reviewer", "operator")).toBe(false);
    expect(requireWorkspaceRole("reviewer", "reviewer")).toBe(true);
    expect(requireWorkspaceRole("admin", "owner")).toBe(true);
  });
});

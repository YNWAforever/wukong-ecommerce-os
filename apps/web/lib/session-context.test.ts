import { describe, expect, it } from "vitest";

import {
  createAuthSessionContextPort,
  requireWorkspaceRole,
  sessionContext,
  type MembershipRepository,
} from "./session-context";

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

  it("resolves the authenticated session through the membership port", async () => {
    const port = createAuthSessionContextPort({
      resolveAuth: async () => ({ user: { id: "user_opak_operator" } }),
      membershipLookup: async (userId) =>
        userId === "user_opak_operator"
          ? { workspaceId: "ws_opak", actorId: userId, role: "operator" }
          : null,
    });
    await expect(port.resolve()).resolves.toEqual({
      workspaceId: "ws_opak",
      actorId: "user_opak_operator",
      role: "operator",
    });
  });

  it("returns null for an unauthenticated Auth.js session", async () => {
    const port = createAuthSessionContextPort({
      resolveAuth: async () => null,
      membershipLookup: async () => {
        throw new Error("must not query memberships without a user");
      },
    });
    await expect(port.resolve()).resolves.toBeNull();
  });

  it("enforces viewer < operator < reviewer < admin", () => {
    expect(requireWorkspaceRole("operator", "viewer")).toBe(false);
    expect(requireWorkspaceRole("operator", "operator")).toBe(true);
    expect(requireWorkspaceRole("reviewer", "operator")).toBe(false);
    expect(requireWorkspaceRole("reviewer", "reviewer")).toBe(true);
    expect(requireWorkspaceRole("admin", "owner")).toBe(true);
  });
});

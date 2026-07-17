import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getAuthDatabase: vi.fn(),
  getSession: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: authMocks.headers }));
vi.mock("../auth", () => ({
  auth: { api: { getSession: authMocks.getSession } },
  getAuthDatabase: authMocks.getAuthDatabase,
}));

import {
  createAuthSessionContextPort,
  requireWorkspaceRole,
  sessionContext,
  type MembershipRepository,
} from "./session-context";

describe("session context", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

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

  it("resolves a Better Auth session before looking up active membership", async () => {
    vi.stubEnv("AUTH_SMTP_URL", "smtp://localhost:1025");
    vi.stubEnv("AUTH_EMAIL_FROM", "auth@wukong.test");
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/wukong");
    const requestHeaders = new Headers({ cookie: "better-auth.session_token=opaque" });
    authMocks.headers.mockResolvedValue(requestHeaders);
    authMocks.getSession.mockResolvedValue({
      user: { id: "user_opak_operator", email: "operator@opak.example" },
      session: { id: "session_1", userId: "user_opak_operator" },
    });
    authMocks.execute.mockResolvedValue([
      { workspace_id: "ws_opak", actor_id: "user_opak_operator", role: "operator" },
    ]);
    authMocks.getAuthDatabase.mockReturnValue({ execute: authMocks.execute });

    await expect(createAuthSessionContextPort().resolve()).resolves.toEqual({
      workspaceId: "ws_opak",
      actorId: "user_opak_operator",
      role: "operator",
    });
    expect(authMocks.getSession).toHaveBeenCalledWith({ headers: requestHeaders });
    expect(authMocks.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(authMocks.execute.mock.calls[0]?.[0])).toContain("auth_get_active_membership");
  });

  it("returns null for an unauthenticated Better Auth session", async () => {
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

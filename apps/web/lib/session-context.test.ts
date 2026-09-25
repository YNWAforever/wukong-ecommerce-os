import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getAuthDatabase: vi.fn(),
  getSession: vi.fn(),
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: authMocks.headers,
  cookies: authMocks.cookies,
}));
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
        {
          user: { id: "user_opak_operator", email: "operator@opak.example" },
          workspaceId: "attacker",
        },
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
      sessionContext(
        { user: { id: "unknown", email: "unknown@example.com" } },
        memberships,
      ),
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
    const requestHeaders = new Headers({
      cookie: "better-auth.session_token=opaque",
    });
    authMocks.headers.mockResolvedValue(requestHeaders);
    authMocks.cookies.mockResolvedValue({ get: () => undefined });
    authMocks.getSession.mockResolvedValue({
      user: { id: "user_opak_operator", email: "operator@opak.example" },
      session: { id: "session_1", userId: "user_opak_operator" },
    });
    authMocks.execute.mockResolvedValue([
      {
        workspace_id: "ws_opak",
        actor_id: "user_opak_operator",
        role: "operator",
      },
    ]);
    authMocks.getAuthDatabase.mockReturnValue({ execute: authMocks.execute });

    await expect(createAuthSessionContextPort().resolve()).resolves.toEqual({
      workspaceId: "ws_opak",
      actorId: "user_opak_operator",
      role: "operator",
    });
    expect(authMocks.getSession).toHaveBeenCalledWith({
      headers: requestHeaders,
    });
    expect(authMocks.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(authMocks.execute.mock.calls[0]?.[0])).toContain(
      "auth_get_active_membership",
    );
  });

  it("uses a preferred workspace cookie only through the membership query", async () => {
    vi.stubEnv("AUTH_SMTP_URL", "smtp://localhost:1025");
    vi.stubEnv("AUTH_EMAIL_FROM", "auth@wukong.test");
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/wukong");
    authMocks.headers.mockResolvedValue(new Headers());
    authMocks.cookies.mockResolvedValue({
      get: () => ({ value: "ws_preferred" }),
    });
    authMocks.getSession.mockResolvedValue({
      user: { id: "user_opak_operator" },
    });
    authMocks.execute.mockResolvedValue([
      {
        workspace_id: "ws_preferred",
        actor_id: "user_opak_operator",
        role: "admin",
      },
    ]);
    authMocks.getAuthDatabase.mockReturnValue({ execute: authMocks.execute });

    await expect(createAuthSessionContextPort().resolve()).resolves.toEqual({
      workspaceId: "ws_preferred",
      actorId: "user_opak_operator",
      role: "admin",
    });
    const query = JSON.stringify(authMocks.execute.mock.calls[0]?.[0]);
    expect(query).toContain("auth_get_active_membership");
    expect(query).toContain("ws_preferred");
  });
  it("uses the existing membership function until the selector migration is applied", async () => {
    vi.stubEnv("AUTH_SMTP_URL", "smtp://localhost:1025");
    vi.stubEnv("AUTH_EMAIL_FROM", "auth@wukong.test");
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/wukong");
    authMocks.headers.mockResolvedValue(new Headers());
    authMocks.cookies.mockResolvedValue({ get: () => ({ value: "ws_new" }) });
    authMocks.getSession.mockResolvedValue({ user: { id: "user_1" } });
    authMocks.execute
      .mockRejectedValueOnce(
        Object.assign(new Error("undefined function"), { code: "42883" }),
      )
      .mockResolvedValueOnce([
        { workspace_id: "ws_old", actor_id: "user_1", role: "viewer" },
      ]);
    authMocks.getAuthDatabase.mockReturnValue({ execute: authMocks.execute });

    await expect(createAuthSessionContextPort().resolve()).resolves.toEqual({
      workspaceId: "ws_old",
      actorId: "user_1",
      role: "viewer",
    });
    expect(authMocks.execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(authMocks.execute.mock.calls[1]?.[0])).not.toContain(
      "ws_new",
    );
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

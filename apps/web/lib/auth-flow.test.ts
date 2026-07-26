import { describe, expect, it, vi } from "vitest";

import { createAuthFlow, safeCallbackPath } from "./auth-flow";

const NOW = new Date("2026-07-15T04:00:00.000Z");

function harness(
  options: {
    eligible?: boolean;
    credential?: boolean;
    enrollmentComplete?: boolean;
    lockedUntil?: Date | null;
    authResponse?: Response;
  } = {},
) {
  const user =
    options.eligible === false
      ? null
      : { id: "user_1", email: "admin@example.com" };
  const access = {
    findEligibleUser: vi.fn().mockResolvedValue(user),
    hasCredential: vi.fn().mockResolvedValue(options.credential ?? false),
    isEnrollmentComplete: vi
      .fn()
      .mockResolvedValue(options.enrollmentComplete ?? true),
    getPasswordGuard: vi.fn().mockResolvedValue({
      failedAttempts: 0,
      lockedUntil: options.lockedUntil ?? null,
    }),
    recordPasswordFailure: vi
      .fn()
      .mockResolvedValue({ failedAttempts: 1, lockedUntil: null }),
    clearPasswordGuard: vi.fn().mockResolvedValue(undefined),
    completeEnrollment: vi.fn().mockResolvedValue(undefined),
    revokeUserSessions: vi.fn().mockResolvedValue(undefined),
    writeAuthAudit: vi.fn().mockResolvedValue(undefined),
  };
  const auth = {
    handler: vi
      .fn()
      .mockResolvedValue(options.authResponse ?? Response.json({ ok: true })),
  };
  const observe = vi.fn();
  return {
    access,
    auth,
    observe,
    flow: createAuthFlow({ auth, access, now: () => NOW, observe }),
  };
}

async function forwardedBody(auth: { handler: ReturnType<typeof vi.fn> }) {
  const request = auth.handler.mock.calls[0]![0] as Request;
  return { path: new URL(request.url).pathname, body: await request.json() };
}

describe("invite-aware authentication flow", () => {
  it("requests enrollment only for an invited existing user without a credential", async () => {
    const { flow, auth, access } = harness();
    await expect(
      flow.requestEnrollment({
        email: " Admin@Example.com ",
        callbackURL: "/listings?view=mine",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(await forwardedBody(auth)).toEqual({
      path: "/api/auth/request-password-reset",
      body: {
        email: "admin@example.com",
        redirectTo:
          "/register/set-password?callbackUrl=%2Flistings%3Fview%3Dmine",
      },
    });
    expect(access.writeAuthAudit).toHaveBeenCalledWith({
      email: "admin@example.com",
      userId: "user_1",
      outcome: "success",
      reason: "password_enrollment_requested",
    });
  });

  it.each([{ eligible: false }, { credential: true }])(
    "keeps enrollment generic and does not forward for ineligible state %#",
    async (state) => {
      const { flow, auth } = harness(state);
      await expect(
        flow.requestEnrollment({ email: "unknown@example.com" }),
      ).resolves.toEqual({ accepted: true });
      expect(auth.handler).not.toHaveBeenCalled();
    },
  );

  it("re-sends enrollment after a transient completion failure created a credential", async () => {
    const { flow, auth } = harness({
      credential: true,
      enrollmentComplete: false,
    });
    await expect(
      flow.requestEnrollment({
        email: "admin@example.com",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(await forwardedBody(auth)).toEqual({
      path: "/api/auth/request-password-reset",
      body: {
        email: "admin@example.com",
        redirectTo: "/register/set-password?callbackUrl=%2Fdashboard",
      },
    });
  });

  it("does not attempt password authentication for an ineligible or locked user", async () => {
    for (const state of [
      { eligible: false },
      { credential: true, lockedUntil: new Date(NOW.getTime() + 1) },
    ]) {
      const { flow, auth } = harness(state);
      await expect(
        flow.passwordSignIn({
          email: "ADMIN@example.com",
          password: "secret-password",
          callbackURL: "/dashboard",
        }),
      ).resolves.toEqual({ ok: false, cookies: [] });
      expect(auth.handler).not.toHaveBeenCalled();
    }
  });

  it("records a failed password response and audits the fifth-attempt lockout", async () => {
    const { flow, access } = harness({
      credential: true,
      authResponse: Response.json({ error: "bad" }, { status: 401 }),
    });
    access.recordPasswordFailure.mockResolvedValue({
      failedAttempts: 5,
      lockedUntil: new Date(NOW.getTime() + 15 * 60_000),
    });
    await expect(
      flow.passwordSignIn({
        email: " Admin@Example.com ",
        password: "not-the-password",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });
    expect(access.recordPasswordFailure).toHaveBeenCalledWith(
      "admin@example.com",
      NOW,
    );
    expect(access.writeAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "password_login_rejected" }),
    );
    expect(access.writeAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "password_login_locked" }),
    );
  });

  it("clears the guard and preserves every Set-Cookie header after successful password authentication", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "session=one; Path=/; HttpOnly");
    headers.append("set-cookie", "csrf=two; Path=/; SameSite=Lax");
    const { flow, auth, access } = harness({
      credential: true,
      authResponse: new Response(null, { status: 200, headers }),
    });
    const result = await flow.passwordSignIn({
      email: " Admin@Example.com ",
      password: "correct horse battery staple",
      callbackURL: "/listings?view=mine",
    });
    expect(result.ok).toBe(true);
    expect(result.cookies).toEqual([
      "session=one; Path=/; HttpOnly",
      "csrf=two; Path=/; SameSite=Lax",
    ]);
    expect(await forwardedBody(auth)).toEqual({
      path: "/api/auth/sign-in/email",
      body: {
        email: "admin@example.com",
        password: "correct horse battery staple",
        callbackURL: "/listings?view=mine",
      },
    });
    expect(access.clearPasswordGuard).toHaveBeenCalledWith("admin@example.com");
  });

  it("allows an eligible magic-link request during password lockout", async () => {
    const { flow, auth, access } = harness({
      credential: true,
      lockedUntil: new Date(NOW.getTime() + 60_000),
    });
    await expect(
      flow.requestMagicLink({
        email: " ADMIN@example.com ",
        callbackURL: "/dashboard",
      }),
    ).resolves.toEqual({ accepted: true });
    expect((await forwardedBody(auth)).path).toBe(
      "/api/auth/sign-in/magic-link",
    );
    expect(access.getPasswordGuard).not.toHaveBeenCalled();
  });

  it("sends reset only for an eligible credential user while keeping every public response identical", async () => {
    const allowed = harness({ credential: true });
    const denied = harness({ credential: false });
    await expect(
      allowed.flow.requestPasswordReset({
        email: "ADMIN@example.com",
        callbackURL: "/listings?view=mine",
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      denied.flow.requestPasswordReset({
        email: "ADMIN@example.com",
        callbackURL: "/listings?view=mine",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(await forwardedBody(allowed.auth)).toEqual({
      path: "/api/auth/request-password-reset",
      body: {
        email: "admin@example.com",
        redirectTo: "/reset-password?callbackUrl=%2Flistings%3Fview%3Dmine",
      },
    });
    expect(denied.auth.handler).not.toHaveBeenCalled();
  });

  it("uses a dashboard fallback for unsafe or malformed callback paths", () => {
    expect(safeCallbackPath("/listings?view=mine")).toBe("/listings?view=mine");
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/..//evil.example",
      "/%2e%2e//evil.example",
      "/%252e%252e//evil.example",
      "\\evil",
      "/safe\\evil",
      "/\u0085/evil",
      "/%C2%85/evil",
      "/\u200b/evil",
      "/%E2%80%8B/evil",
      "%",
      undefined,
    ]) {
      expect(safeCallbackPath(value)).toBe("/dashboard");
    }
  });
  it("does not count a valid password as a failure when post-auth guard clearing fails", async () => {
    const { flow, access } = harness({
      credential: true,
      authResponse: new Response(null, { status: 200 }),
    });
    access.clearPasswordGuard.mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      flow.passwordSignIn({
        email: "admin@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });
    expect(access.recordPasswordFailure).not.toHaveBeenCalled();
    expect(access.revokeUserSessions).toHaveBeenCalledWith("user_1");
  });
  it("uses the created session cookie to sign out when repository revocation fails", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "better-auth.session_token=created-session; Path=/; HttpOnly",
    );
    const { flow, auth, access } = harness({ credential: true });
    auth.handler
      .mockResolvedValueOnce(new Response(null, { status: 200, headers }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    access.clearPasswordGuard.mockRejectedValue(new Error("guard unavailable"));
    access.revokeUserSessions.mockRejectedValue(
      new Error("repository unavailable"),
    );

    await expect(
      flow.passwordSignIn({
        email: "admin@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });

    const signOut = auth.handler.mock.calls[1]![0] as Request;
    expect(new URL(signOut.url).pathname).toBe("/api/auth/sign-out");
    expect(signOut.headers.get("cookie")).toBe(
      "better-auth.session_token=created-session",
    );
    expect(access.recordPasswordFailure).not.toHaveBeenCalled();
  });

  it("still uses repository revocation when internal sign-out fails", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "better-auth.session_token=created-session; Path=/; HttpOnly",
    );
    const { flow, auth, access } = harness({ credential: true });
    auth.handler
      .mockResolvedValueOnce(new Response(null, { status: 200, headers }))
      .mockRejectedValueOnce(new Error("sign-out unavailable"));
    access.clearPasswordGuard.mockRejectedValue(new Error("guard unavailable"));

    await expect(
      flow.passwordSignIn({
        email: "admin@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });

    expect(access.revokeUserSessions).toHaveBeenCalledWith("user_1");
    expect(access.recordPasswordFailure).not.toHaveBeenCalled();
  });

  it("keeps cleanup failure generic and audits without the session credential", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "better-auth.session_token=created-session; Path=/; HttpOnly",
    );
    const { flow, auth, access } = harness({ credential: true });
    auth.handler
      .mockResolvedValueOnce(new Response(null, { status: 200, headers }))
      .mockRejectedValueOnce(new Error("sign-out unavailable"));
    access.clearPasswordGuard.mockRejectedValue(new Error("guard unavailable"));
    access.revokeUserSessions.mockRejectedValue(
      new Error("repository unavailable"),
    );

    await expect(
      flow.passwordSignIn({
        email: "admin@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });

    expect(access.writeAuthAudit).toHaveBeenCalledWith({
      email: "admin@example.com",
      userId: "user_1",
      outcome: "failure",
      reason: "password_login_rejected",
    });
    expect(JSON.stringify(access.writeAuthAudit.mock.calls)).not.toContain(
      "created-session",
    );
  });

  it("does not count a password failure when guard lookup throws", async () => {
    const { flow, access } = harness({ credential: true });
    access.getPasswordGuard.mockRejectedValue(new Error("guard unavailable"));
    await expect(
      flow.passwordSignIn({
        email: "admin@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });
    expect(access.recordPasswordFailure).not.toHaveBeenCalled();
  });

  it("does not count a password failure when Better Auth throws", async () => {
    const { flow, auth, access } = harness({ credential: true });
    auth.handler.mockRejectedValue(new Error("auth unavailable"));
    await expect(
      flow.passwordSignIn({
        email: "admin@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, cookies: [] });
    expect(access.recordPasswordFailure).not.toHaveBeenCalled();
  });
});

describe("authentication flow observability", () => {
  it("reports why an ineligible magic link stopped, without leaking the address", async () => {
    const { flow, auth, observe } = harness({ eligible: false });
    await expect(
      flow.requestMagicLink({ email: "stranger@example.com" }),
    ).resolves.toEqual({ accepted: true });
    expect(auth.handler).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({
      outcome: "failure",
      reason: "magic_link_rejected",
    });
    for (const [observation] of observe.mock.calls) {
      expect(JSON.stringify(observation)).not.toContain("stranger@example.com");
    }
  });

  it("separates an accepted magic link from a rejected one", async () => {
    const { flow, observe } = harness();
    await flow.requestMagicLink({ email: "admin@example.com" });
    expect(observe).toHaveBeenCalledWith({
      outcome: "success",
      reason: "magic_link_accepted",
    });
  });

  it("emits a single-line structured log by default, with no observer injected", async () => {
    const access = harness({ eligible: false }).access;
    const auth = { handler: vi.fn() };
    const flow = createAuthFlow({ auth, access, now: () => NOW });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await flow.requestMagicLink({ email: "stranger@example.com" });
      const lines = info.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(
        JSON.stringify({
          event: "auth_flow",
          outcome: "failure",
          reason: "magic_link_rejected",
        }),
      );
      for (const line of lines) {
        expect(line).not.toContain("stranger@example.com");
        expect(line.includes("\n")).toBe(false);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("still reports the reason when the audit store is unavailable", async () => {
    const { flow, access, observe } = harness({ eligible: false });
    access.writeAuthAudit.mockRejectedValue(new Error("audit store down"));
    await expect(
      flow.requestMagicLink({ email: "stranger@example.com" }),
    ).resolves.toEqual({ accepted: true });
    expect(observe).toHaveBeenCalledWith({
      outcome: "failure",
      reason: "magic_link_rejected",
    });
    expect(observe).toHaveBeenCalledWith({
      outcome: "failure",
      reason: "auth_audit_write_failed",
    });
  });
});

import {
  createAuthAccessRepository,
  type AuthAccessRepository,
} from "@wukong/db";

import { auth, getAuthDatabase } from "../auth";

export type AuthHandler = {
  handler(request: Request): Promise<Response>;
};

export type AuthFlow = ReturnType<typeof createAuthFlow>;

const ACCEPTED = { accepted: true } as const;
const AUTH_ORIGIN = "http://localhost";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function safeCallbackPath(candidate?: string): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return "/dashboard";
  }
  if (/[\u0000-\u001f\\]/.test(candidate)) return "/dashboard";
  try {
    const parsed = new URL(candidate, AUTH_ORIGIN);
    if (parsed.origin !== AUTH_ORIGIN) return "/dashboard";
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return "/dashboard";
  }
}

function authRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(AUTH_ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

export function createAuthFlow({
  auth,
  access,
  now,
}: {
  auth: AuthHandler;
  access: AuthAccessRepository;
  now: () => Date;
}) {
  async function audit(event: Parameters<AuthAccessRepository["writeAuthAudit"]>[0]) {
    try {
      await access.writeAuthAudit(event);
    } catch {
      // Authentication stays generic even when audit persistence is unavailable.
    }
  }

  return {
    async requestEnrollment(input: { email: string }) {
      const email = normalizeEmail(input.email);
      try {
        const user = await access.findEligibleUser(email);
        if (!user) {
          await audit({ email, outcome: "failure", reason: "password_enrollment_rejected" });
          return ACCEPTED;
        }
        const hasCredential = await access.hasCredential(user.id);
        if (hasCredential && await access.isEnrollmentComplete(user.id)) {
          await audit({ email, userId: user.id, outcome: "failure", reason: "password_enrollment_rejected" });
          return ACCEPTED;
        }
        const response = await auth.handler(authRequest("/api/auth/request-password-reset", {
          email,
          redirectTo: "/register/set-password",
        }));
        await audit({
          email,
          userId: user.id,
          outcome: response.ok ? "success" : "failure",
          reason: response.ok ? "password_enrollment_requested" : "password_enrollment_rejected",
        });
      } catch {
        await audit({ email, outcome: "failure", reason: "password_enrollment_rejected" });
      }
      return ACCEPTED;
    },

    async passwordSignIn(input: { email: string; password: string; callbackURL?: string }) {
      const email = normalizeEmail(input.email);
      const failure = { ok: false as const, cookies: [] as string[] };
      let user: { id: string; email: string } | null = null;
      let authenticated = false;
      try {
        user = await access.findEligibleUser(email);
        if (!user || !await access.hasCredential(user.id)) {
          await audit({ email, userId: user?.id, outcome: "failure", reason: "password_login_rejected" });
          return failure;
        }
        const guard = await access.getPasswordGuard(email, now());
        if (guard.lockedUntil) {
          await audit({ email, userId: user.id, outcome: "failure", reason: "password_login_locked" });
          return failure;
        }
        const response = await auth.handler(authRequest("/api/auth/sign-in/email", {
          email,
          password: input.password,
          callbackURL: safeCallbackPath(input.callbackURL),
        }));
        if (!response.ok) {
          const nextGuard = await access.recordPasswordFailure(email, now());
          await audit({ email, userId: user.id, outcome: "failure", reason: "password_login_rejected" });
          if (nextGuard.lockedUntil) {
            await audit({ email, userId: user.id, outcome: "failure", reason: "password_login_locked" });
          }
          return failure;
        }
        authenticated = true;
        await access.clearPasswordGuard(email);
        await audit({ email, userId: user.id, outcome: "success", reason: "password_login_accepted" });
        return { ok: true as const, cookies: responseCookies(response) };
      } catch {
        if (user && authenticated) {
          try {
            await access.revokeUserSessions(user.id);
          } catch {
            // Do not leave a successful sign-in usable after guard cleanup failed.
          }
          return failure;
        }
        if (user) {
          try {
            await access.recordPasswordFailure(email, now());
          } catch {
            // Keep authentication failures generic.
          }
        }
        await audit({ email, userId: user?.id, outcome: "failure", reason: "password_login_rejected" });
        return failure;
      }
    },

    async requestMagicLink(input: { email: string; callbackURL?: string }) {
      const email = normalizeEmail(input.email);
      try {
        const user = await access.findEligibleUser(email);
        if (!user) {
          await audit({ email, outcome: "failure", reason: "magic_link_rejected" });
          return ACCEPTED;
        }
        const response = await auth.handler(authRequest("/api/auth/sign-in/magic-link", {
          email,
          callbackURL: safeCallbackPath(input.callbackURL),
        }));
        await audit({
          email,
          userId: user.id,
          outcome: response.ok ? "success" : "failure",
          reason: response.ok ? "magic_link_accepted" : "magic_link_rejected",
        });
      } catch {
        await audit({ email, outcome: "failure", reason: "magic_link_rejected" });
      }
      return ACCEPTED;
    },

    async requestPasswordReset(input: { email: string; callbackURL?: string }) {
      const email = normalizeEmail(input.email);
      try {
        const user = await access.findEligibleUser(email);
        if (!user || !await access.hasCredential(user.id)) {
          await audit({ email, userId: user?.id, outcome: "failure", reason: "password_reset_rejected" });
          return ACCEPTED;
        }
        const response = await auth.handler(authRequest("/api/auth/request-password-reset", {
          email,
          redirectTo: safeCallbackPath(input.callbackURL),
        }));
        await audit({
          email,
          userId: user.id,
          outcome: response.ok ? "success" : "failure",
          reason: response.ok ? "password_reset_requested" : "password_reset_rejected",
        });
      } catch {
        await audit({ email, outcome: "failure", reason: "password_reset_rejected" });
      }
      return ACCEPTED;
    },
  };
}

export function createRuntimeAuthFlow(): AuthFlow {
  return createAuthFlow({
    auth,
    access: createAuthAccessRepository(getAuthDatabase() as never),
    now: () => new Date(),
  });
}

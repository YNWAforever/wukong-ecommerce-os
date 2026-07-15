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
  if (!candidate?.startsWith("/") || candidate.startsWith("//")) {
    return "/dashboard";
  }
  try {
    let decoded = candidate;
    for (let pass = 0; pass < 5; pass += 1) {
      if (/[\p{White_Space}\p{Cc}\p{Cf}\\]/u.test(decoded)) {
        return "/dashboard";
      }
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (pass === 4) return "/dashboard";
    }

    if (!decoded.startsWith("/") || decoded.startsWith("//")) {
      return "/dashboard";
    }
    const base = new URL(AUTH_ORIGIN + "/");
    const decodedUrl = new URL(decoded, base);
    if (decodedUrl.origin !== base.origin) return "/dashboard";
    const canonical = new URL(candidate, base);
    if (canonical.origin !== base.origin) return "/dashboard";
    return canonical.pathname + canonical.search + canonical.hash;
  } catch {
    return "/dashboard";
  }
}

function completionRedirect(path: string, callbackURL?: string): string {
  return `${path}?callbackUrl=${encodeURIComponent(safeCallbackPath(callbackURL))}`;
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

function sessionCookieHeader(response: Response): string {
  return responseCookies(response)
    .map((cookie) => cookie.split(";", 1)[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie))
    .join("; ");
}

function signOutRequest(cookie: string): Request {
  return new Request(AUTH_ORIGIN + "/api/auth/sign-out", {
    method: "POST",
    headers: { cookie },
  });
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
    async requestEnrollment(input: { email: string; callbackURL?: string }) {
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
          redirectTo: completionRedirect("/register/set-password", input.callbackURL),
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
      let authenticatedResponse: Response | null = null;
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
        authenticatedResponse = response;
        await access.clearPasswordGuard(email);
        await audit({ email, userId: user.id, outcome: "success", reason: "password_login_accepted" });
        return { ok: true as const, cookies: responseCookies(response) };
      } catch {
        if (user && authenticatedResponse) {
          const revocations: Promise<unknown>[] = [
            access.revokeUserSessions(user.id),
          ];
          const cookie = sessionCookieHeader(authenticatedResponse);
          if (cookie) {
            revocations.push(auth.handler(signOutRequest(cookie)));
          }
          await Promise.allSettled(revocations);
          await audit({
            email,
            userId: user.id,
            outcome: "failure",
            reason: "password_login_rejected",
          });
          return failure;
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
          redirectTo: completionRedirect("/reset-password", input.callbackURL),
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

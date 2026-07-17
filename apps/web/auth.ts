import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNextJsHandler } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { headers } from "next/headers";
import {
  authAccounts,
  authRateLimits,
  authSessions,
  authVerifications,
  createAuthAccessRepository,
  createAuthDatabase,
  users,
  type AuthAccessRepository,
  type AuthDatabase,
} from "@wukong/db";

import { sendAuthEmail } from "./lib/auth-mailer";
import { hashPassword, verifyPassword } from "./lib/password-crypto";

export class AuthConfigurationUnavailableError extends Error {
  constructor() {
    super("Authentication is not configured");
    this.name = "AuthConfigurationUnavailableError";
  }
}

export type AuthEnvironment = {
  smtpUrl: string;
  from: string;
  secret: string;
  databaseUrl: string;
};

type AuthDependencies = {
  createAdapter: typeof drizzleAdapter;
  createMagicLink: typeof magicLink;
  sendEmail: typeof sendAuthEmail;
  access?: AuthAccessRepository;
};

const defaultDependencies: AuthDependencies = {
  createAdapter: drizzleAdapter,
  createMagicLink: magicLink,
  sendEmail: sendAuthEmail,
};

function requiredAuthEnv(): AuthEnvironment {
  const smtpUrl = process.env.AUTH_SMTP_URL;
  const from = process.env.AUTH_EMAIL_FROM;
  const secret = process.env.AUTH_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (!smtpUrl || !from || !secret || !databaseUrl) {
    throw new AuthConfigurationUnavailableError();
  }
  return { smtpUrl, from, secret, databaseUrl };
}

export function buildAuthOptions(
  db: AuthDatabase,
  env: AuthEnvironment,
  dependencies: AuthDependencies = defaultDependencies,
): BetterAuthOptions {
  const sendResetPassword: NonNullable<
    NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"]
  > = async ({ user, url }) => {
    await dependencies.sendEmail({
      to: user.email,
      subject: "Reset your Wukong password",
      text: `Use this secure link to reset your password: ${url}`,
      html: `<p>Use this secure link to reset your password:</p><p>${url}</p>`,
    });
  };

  const sendMagicLink = async ({
    email,
    url,
  }: {
    email: string;
    url: string;
  }) => {
    await dependencies.sendEmail({
      to: email,
      subject: "Your Wukong sign-in link",
      text: `Use this secure link to sign in: ${url}`,
      html: `<p>Use this secure link to sign in:</p><p>${url}</p>`,
    });
  };

  const access = dependencies.access ?? createAuthAccessRepository(db);
  return {
    secret: env.secret,
    database: dependencies.createAdapter(db, {
      provider: "pg",
      schema: {
        users,
        authAccounts,
        authSessions,
        authVerifications,
        authRateLimits,
      },
    }),
    user: { modelName: "users" },
    account: { modelName: "authAccounts" },
    session: {
      modelName: "authSessions",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    verification: { modelName: "authVerifications" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
      sendResetPassword,
      resetPasswordTokenExpiresIn: 60 * 30,
      onPasswordReset: async ({ user }) => {
        const email = user.email.trim().toLowerCase();
        if (!user.emailVerified) {
          try {
            await access.completeEnrollment(user.id, email);
          } catch {
            try {
              await access.writeAuthAudit({
                email,
                userId: user.id,
                outcome: "failure",
                reason: "password_enrollment_rejected",
              });
            } catch {
              // Never prevent Better Auth token and session cleanup.
            }
          }
          return;
        }
        const [guard, sessions] = await Promise.allSettled([
          Promise.resolve().then(() => access.clearPasswordGuard(email)),
          Promise.resolve().then(() => access.revokeUserSessions(user.id)),
        ]);
        const completed = guard.status === "fulfilled" && sessions.status === "fulfilled";
        try {
          await access.writeAuthAudit({
            email,
            userId: user.id,
            outcome: completed ? "success" : "failure",
            reason: completed ? "password_reset_completed" : "password_reset_rejected",
          });
        } catch {
          // Better Auth must continue its built-in session revocation.
        }
      },
      revokeSessionsOnPasswordReset: true,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "authRateLimits",
    },
    plugins: [
      dependencies.createMagicLink({
        disableSignUp: true,
        expiresIn: 60 * 30,
        sendMagicLink,
      }),
    ],
  };
}

export function createAuthInstance(
  db: AuthDatabase,
  env: AuthEnvironment,
): ReturnType<typeof betterAuth> {
  return betterAuth(buildAuthOptions(db, env));
}

let runtime: ReturnType<typeof betterAuth> | undefined;
let runtimeDatabase: (AuthDatabase & { close(): Promise<void> }) | undefined;

function getAuthRuntime(): ReturnType<typeof betterAuth> {
  if (runtime) return runtime;
  const env = requiredAuthEnv();
  runtimeDatabase = createAuthDatabase(env.databaseUrl);
  runtime = createAuthInstance(runtimeDatabase, env);
  return runtime;
}

export type AuthDatabaseHandle = Omit<AuthDatabase, "execute"> & {
  execute<T>(query: unknown): Promise<T[]>;
};

export function getAuthDatabase(): AuthDatabaseHandle {
  getAuthRuntime();
  if (!runtimeDatabase) throw new AuthConfigurationUnavailableError();
  return runtimeDatabase as unknown as AuthDatabaseHandle;
}

const lazyHandler = (request: Request): Promise<Response> =>
  getAuthRuntime().handler(request);
const resolveSession = async () =>
  getAuthRuntime().api.getSession({ headers: await headers() });

type BetterAuthInstance = ReturnType<typeof betterAuth>;
type CallableBetterAuth = BetterAuthInstance & typeof resolveSession;
const authTarget = Object.assign(resolveSession, {
  handler: lazyHandler,
}) as CallableBetterAuth;
export const auth: CallableBetterAuth = new Proxy(authTarget, {
  get(target, property, receiver) {
    if (property === "handler") return Reflect.get(target, property, receiver);
    const activeRuntime = getAuthRuntime();
    const value = Reflect.get(activeRuntime, property, activeRuntime);
    return typeof value === "function" ? value.bind(activeRuntime) : value;
  },
});

export const handlers = toNextJsHandler(auth);

export function isAuthConfigured(): boolean {
  return Boolean(
    process.env.AUTH_SMTP_URL &&
    process.env.AUTH_EMAIL_FROM &&
    process.env.AUTH_SECRET &&
    process.env.DATABASE_URL,
  );
}

export function closeAuthDatabase(): Promise<void> {
  return runtimeDatabase?.close() ?? Promise.resolve();
}

import { describe, expect, it, vi } from "vitest";

import {
  authAccounts,
  authRateLimits,
  authSessions,
  authVerifications,
  users,
  type AuthDatabase,
} from "@wukong/db";
import { auth, buildAuthOptions } from "./auth";
import { hashPassword } from "./lib/password-crypto";

describe("Better Auth configuration", () => {
  it("keeps the lazy auth export callable for the existing session boundary", () => {
    expect(typeof auth).toBe("function");
  });

  const env = {
    secret: "test-secret-with-at-least-32-characters",
    databaseUrl: "postgres://database.example/app",
    smtpUrl: "smtps://resend:secret@smtp.resend.com:465",
    from: "Wukong Auth <auth@example.com>",
  };

  it("uses the dedicated Drizzle models and database-backed sessions", () => {
    const adapter = { id: "drizzle-adapter" };
    const createAdapter = vi.fn(() => adapter);
    const createMagicLink = vi.fn((options) => ({ id: "magic-link", options }));
    const options = buildAuthOptions({} as AuthDatabase, env, {
      createAdapter: createAdapter as never,
      createMagicLink: createMagicLink as never,
      sendEmail: vi.fn(),
    });

    expect(createAdapter).toHaveBeenCalledWith(
      {},
      {
        provider: "pg",
        schema: {
          users,
          authAccounts,
          authSessions,
          authVerifications,
          authRateLimits,
        },
      },
    );
    expect(options.database).toBe(adapter);
    expect(options.user).toEqual({ modelName: "users" });
    expect(options.account).toEqual({ modelName: "authAccounts" });
    expect(options.session).toEqual({
      modelName: "authSessions",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    });
    expect(options.verification).toEqual({ modelName: "authVerifications" });
    expect(options.rateLimit).toEqual({
      enabled: true,
      storage: "database",
      modelName: "authRateLimits",
    });
  });

  it("delegates password crypto and configures reset security", async () => {
    const options = buildAuthOptions({} as AuthDatabase, env, {
      createAdapter: (() => ({ id: "adapter" })) as never,
      createMagicLink: ((pluginOptions: unknown) => ({
        id: "magic-link",
        pluginOptions,
      })) as never,
      sendEmail: vi.fn(),
    });
    const password = "correct horse battery staple";
    const encoded = await options.emailAndPassword!.password!.hash!(password);

    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 30,
      revokeSessionsOnPasswordReset: true,
    });
    expect(options.emailAndPassword!.password!.hash).toBe(hashPassword);
    await expect(
      options.emailAndPassword!.password!.verify!({ hash: encoded, password }),
    ).resolves.toBe(true);
  });

  it("sends reset and magic-link emails while disabling magic-link signup", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const createMagicLink = vi.fn((options) => ({ id: "magic-link", options }));
    const options = buildAuthOptions({} as AuthDatabase, env, {
      createAdapter: (() => ({ id: "adapter" })) as never,
      createMagicLink: createMagicLink as never,
      sendEmail,
    });

    await options.emailAndPassword!.sendResetPassword!({
      user: { email: "admin@example.com" },
      url: "https://app.example/reset-password?token=reset-token",
      token: "reset-token",
    } as never);
    const magicLinkOptions = createMagicLink.mock.calls[0]![0] as {
      disableSignUp: boolean;
      expiresIn: number;
      sendMagicLink(data: {
        email: string;
        url: string;
        token: string;
      }): Promise<void>;
    };
    expect(magicLinkOptions).toMatchObject({
      disableSignUp: true,
      expiresIn: 60 * 30,
    });
    await magicLinkOptions.sendMagicLink({
      email: "admin@example.com",
      url: "https://app.example/magic-link/verify?token=magic-token",
      token: "magic-token",
    });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({
      to: "admin@example.com",
    });
    expect(sendEmail.mock.calls[0]![0].text).toContain(
      "https://app.example/reset-password",
    );
    expect(sendEmail.mock.calls[1]![0]).toMatchObject({
      to: "admin@example.com",
    });
    expect(sendEmail.mock.calls[1]![0].text).toContain(
      "https://app.example/magic-link/verify",
    );
  });
});

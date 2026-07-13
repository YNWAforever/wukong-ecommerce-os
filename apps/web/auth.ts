import NextAuth, { type NextAuthResult } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { sql } from "drizzle-orm";
import {
  createAuthDatabase,
  type AuthDatabase,
  users,
  authAuditEvents,
} from "@wukong/db";
import { accounts, sessions, verificationTokens } from "@wukong/db";

export class AuthConfigurationUnavailableError extends Error {
  constructor() {
    super("Authentication is not configured");
    this.name = "AuthConfigurationUnavailableError";
  }
}

export type AuthAuditOutcome = "accepted" | "rejected";
export type AuthAuditWriter = (event: {
  email: string;
  userId?: string | null;
  outcome: AuthAuditOutcome;
  reason?: string;
}) => Promise<void>;

export type InviteLookup = (email: string) => Promise<boolean>;

function requiredAuthEnv(): { smtp: string; from: string; secret: string; databaseUrl: string } {
  const smtp = process.env.AUTH_SMTP_URL;
  const from = process.env.AUTH_EMAIL_FROM;
  const secret = process.env.AUTH_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (!smtp || !from || !secret || !databaseUrl) throw new AuthConfigurationUnavailableError();
  return { smtp, from, secret, databaseUrl };
}

function defaultInviteLookup(db: AuthDatabase): InviteLookup {
  return async (email) => {
    const result = await db.execute<{ invited: boolean }>(sql`select auth_has_pending_invite(${email}) as invited`);
    return Boolean(result[0]?.invited);
  };
}

function defaultAuditWriter(db: AuthDatabase): AuthAuditWriter {
  return async (event) => {
    await db.insert(authAuditEvents).values({
      email: event.email,
      userId: event.userId ?? null,
      outcome: event.outcome,
      reason: event.reason ?? null,
    });
  };
}

export function createAuthResult(
  db: AuthDatabase,
  options: { inviteLookup?: InviteLookup; auditWriter?: AuthAuditWriter; secret?: string } = {},
): NextAuthResult {
  const inviteLookup = options.inviteLookup ?? defaultInviteLookup(db);
  const auditWriter = options.auditWriter ?? defaultAuditWriter(db);
  const secret = options.secret ?? process.env.AUTH_SECRET;
  if (!secret) throw new AuthConfigurationUnavailableError();

  return NextAuth({
    secret,
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    providers: [
      Nodemailer({
        server: process.env.AUTH_SMTP_URL,
        from: process.env.AUTH_EMAIL_FROM,
      }),
    ],
    session: { strategy: "database" },
    callbacks: {
      async signIn({ user }) {
        const email = user.email?.trim().toLowerCase();
        if (!email) {
          await auditWriter({ email: "unknown", userId: user.id, outcome: "rejected", reason: "missing_email" });
          return false;
        }
        const invited = await inviteLookup(email);
        await auditWriter({
          email,
          userId: user.id,
          outcome: invited ? "accepted" : "rejected",
          reason: invited ? undefined : "invite_required",
        });
        return invited;
      },
      async session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
    },
  });
}

let runtime: NextAuthResult | undefined;
let runtimeDatabase: (AuthDatabase & { close(): Promise<void> }) | undefined;

export function getAuthResult(): NextAuthResult {
  if (runtime) return runtime;
  const env = requiredAuthEnv();
  runtimeDatabase = createAuthDatabase(env.databaseUrl);
  runtime = createAuthResult(runtimeDatabase, { secret: env.secret });
  return runtime;
}

export const handlers: NextAuthResult["handlers"] = {
  GET: (request) => getAuthResult().handlers.GET(request),
  POST: (request) => getAuthResult().handlers.POST(request),
};

export const auth: NextAuthResult["auth"] = ((...args: unknown[]) => {
  return (getAuthResult().auth as unknown as (...args: unknown[]) => unknown)(...args);
}) as unknown as NextAuthResult["auth"];

export const signIn: NextAuthResult["signIn"] = ((...args: unknown[]) => {
  return (getAuthResult().signIn as unknown as (...args: unknown[]) => unknown)(...args);
}) as unknown as NextAuthResult["signIn"];

export const signOut: NextAuthResult["signOut"] = ((...args: unknown[]) => {
  return (getAuthResult().signOut as unknown as (...args: unknown[]) => unknown)(...args);
}) as unknown as NextAuthResult["signOut"];
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

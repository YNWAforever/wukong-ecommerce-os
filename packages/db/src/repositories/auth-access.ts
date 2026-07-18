import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { AuthDatabase } from "../client.js";
import {
  authAccounts,
  authAuditEvents,
  authSessions,
  passwordLoginGuards,
} from "../schema.js";

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export type EligibleAuthUser = {
  id: string;
  email: string;
};

export type PasswordGuard = {
  failedAttempts: number;
  lockedUntil: Date | null;
};

export type AuthAuditEvent = {
  email: string;
  userId?: string | null;
  outcome: string;
  reason?: string | null;
};

export type AuthAccessRepository = {
  findEligibleUser(email: string): Promise<EligibleAuthUser | null>;
  hasCredential(userId: string): Promise<boolean>;
  isEnrollmentComplete(userId: string): Promise<boolean>;
  getPasswordGuard(email: string, now: Date): Promise<PasswordGuard>;
  recordPasswordFailure(email: string, now: Date): Promise<PasswordGuard>;
  clearPasswordGuard(email: string): Promise<void>;
  completeEnrollment(userId: string, email: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
  writeAuthAudit(event: AuthAuditEvent): Promise<void>;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createAuthAccessRepository(
  db: AuthDatabase,
): AuthAccessRepository {
  return {
    async findEligibleUser(candidateEmail) {
      const email = normalizeEmail(candidateEmail);
      const [user] = await db.execute<{ userId: string; email: string }>(sql`
        select user_id as "userId", email
        from auth_get_eligible_user(${email})
      `);
      return user
        ? { id: user.userId, email: normalizeEmail(user.email) }
        : null;
    },

    async hasCredential(userId) {
      const [credential] = await db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, userId),
            eq(authAccounts.providerId, "credential"),
            isNotNull(authAccounts.password),
            sql`${authAccounts.password} <> ''`,
          ),
        )
        .limit(1);
      return Boolean(credential);
    },

    async isEnrollmentComplete(userId) {
      const [result] = await db.execute<{ completed: boolean }>(sql`
        select auth_is_enrollment_complete(${userId}) as completed
      `);
      return Boolean(result?.completed);
    },

    async getPasswordGuard(candidateEmail, now) {
      const email = normalizeEmail(candidateEmail);
      return db.transaction(async (transaction) => {
        const [guard] = await transaction
          .select({
            failedAttempts: passwordLoginGuards.failedAttempts,
            lockedUntil: passwordLoginGuards.lockedUntil,
          })
          .from(passwordLoginGuards)
          .where(eq(passwordLoginGuards.email, email))
          .for("update")
          .limit(1);
        if (!guard) return { failedAttempts: 0, lockedUntil: null };
        if (guard.lockedUntil && guard.lockedUntil.getTime() <= now.getTime()) {
          await transaction
            .update(passwordLoginGuards)
            .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
            .where(eq(passwordLoginGuards.email, email));
          return { failedAttempts: 0, lockedUntil: null };
        }
        return guard;
      });
    },

    async recordPasswordFailure(candidateEmail, now) {
      const email = normalizeEmail(candidateEmail);
      const [guard] = await db.execute<{
        failedAttempts: number;
        lockedUntil: Date | null;
      }>(sql`
        insert into password_login_guards (email, failed_attempts, locked_until, updated_at)
        values (${email}, 1, null, ${sql.param(now, passwordLoginGuards.updatedAt)})
        on conflict (email) do update set
          failed_attempts = case
            when password_login_guards.locked_until > ${sql.param(now, passwordLoginGuards.lockedUntil)}
              then password_login_guards.failed_attempts
            when password_login_guards.locked_until <= ${sql.param(now, passwordLoginGuards.lockedUntil)}
              then 1
            else least(password_login_guards.failed_attempts + 1, ${LOCKOUT_ATTEMPTS})
          end,
          locked_until = case
            when password_login_guards.locked_until > ${sql.param(now, passwordLoginGuards.lockedUntil)}
              then password_login_guards.locked_until
            when password_login_guards.locked_until <= ${sql.param(now, passwordLoginGuards.lockedUntil)}
              then null
            when password_login_guards.failed_attempts + 1 >= ${LOCKOUT_ATTEMPTS}
              then ${sql.param(new Date(now.getTime() + LOCKOUT_DURATION_MS), passwordLoginGuards.lockedUntil)}
            else null
          end,
          updated_at = ${sql.param(now, passwordLoginGuards.updatedAt)}
        returning
          failed_attempts as "failedAttempts",
          locked_until as "lockedUntil"
      `);
      if (!guard) throw new Error("password guard update failed");
      return {
        failedAttempts: guard.failedAttempts,
        lockedUntil: guard.lockedUntil
          ? new Date(guard.lockedUntil as unknown as string)
          : null,
      };
    },

    async clearPasswordGuard(candidateEmail) {
      await db
        .delete(passwordLoginGuards)
        .where(eq(passwordLoginGuards.email, normalizeEmail(candidateEmail)));
    },

    async completeEnrollment(userId, candidateEmail) {
      const email = normalizeEmail(candidateEmail);
      const [result] = await db.execute<{ completed: boolean }>(sql`
        select auth_complete_enrollment(${userId}, ${email}) as completed
      `);
      if (!result?.completed) throw new Error("eligible invite not found");
    },

    async revokeUserSessions(userId) {
      await db.delete(authSessions).where(eq(authSessions.userId, userId));
    },

    async writeAuthAudit(event) {
      await db.insert(authAuditEvents).values({
        email: normalizeEmail(event.email),
        userId: event.userId ?? null,
        outcome: event.outcome,
        reason: event.reason ?? null,
      });
    },
  };
}

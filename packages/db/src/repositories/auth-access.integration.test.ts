import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  authAccounts,
  authAuditEvents,
  authSessions,
  createAuthAccessRepository,
  createAuthDatabase,
  createDatabase,
  passwordLoginGuards,
  users,
  workspaceInvites,
  workspaces,
} from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const runtimeUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const now = new Date("2026-07-15T00:00:00.000Z");
const email = "admin@example.com";
const userId = "user_auth_access";
const otherUserId = "user_auth_access_other";
const workspaceId = "ws_auth_access";

describe("auth access repository", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const migrationDatabase = createDatabase(adminUrl, {
    migrationUrl: adminUrl,
  });
  const db = createAuthDatabase(adminUrl);
  const repository = createAuthAccessRepository(db);
  const runtimeDb = createAuthDatabase(runtimeUrl);
  const runtimeRepository = createAuthAccessRepository(runtimeDb);

  beforeAll(async () => {
    await migrationDatabase.migrate();
  });

  beforeEach(async () => {
    await admin`delete from auth_audit_events where email = ${email}`;
    await admin`delete from password_login_guards where email = ${email}`;
    await admin`delete from auth_sessions where user_id in (${userId}, ${otherUserId})`;
    await admin`delete from auth_accounts where user_id in (${userId}, ${otherUserId})`;
    await admin`delete from workspace_invites where workspace_id = ${workspaceId}`;
    await admin`delete from users where id in (${userId}, ${otherUserId})`;
    await admin`delete from workspaces where id = ${workspaceId}`;
    await db
      .insert(workspaces)
      .values({ id: workspaceId, name: "Auth access", profile: {} });
    await db.insert(users).values([
      { id: userId, email },
      { id: otherUserId, email: "other@example.com" },
    ]);
  });

  afterAll(async () => {
    await runtimeDb.close();
    await db.close();
    await migrationDatabase.close();
    await admin.end();
  });

  it.each(["pending", "accepted"])(
    "normalizes email and accepts a %s invite",
    async (status) => {
      await db.insert(workspaceInvites).values({
        workspaceId,
        email: "ADMIN@EXAMPLE.COM",
        role: "operator",
        status,
      });
      await expect(
        repository.findEligibleUser(" Admin@Example.com "),
      ).resolves.toEqual({ id: userId, email });
    },
  );

  it("finds an eligible invite through the restricted runtime role", async () => {
    await db.insert(workspaceInvites).values({
      workspaceId,
      email: "ADMIN@EXAMPLE.COM",
      role: "operator",
      status: "pending",
    });
    await expect(
      runtimeRepository.findEligibleUser(" Admin@Example.com "),
    ).resolves.toEqual({
      id: userId,
      email,
    });
  });

  it("completes enrollment through the restricted runtime role", async () => {
    await db.insert(workspaceInvites).values({
      workspaceId,
      email,
      role: "operator",
      status: "pending",
    });
    await runtimeRepository.completeEnrollment(userId, email);
    await expect(runtimeRepository.isEnrollmentComplete(userId)).resolves.toBe(
      true,
    );
    const [invite] = await db
      .select({ status: workspaceInvites.status })
      .from(workspaceInvites)
      .where(eq(workspaceInvites.email, email));
    expect(invite?.status).toBe("accepted");
  });

  it("reports enrollment complete only after verification and invite acceptance", async () => {
    await db.insert(workspaceInvites).values({
      workspaceId,
      email,
      role: "operator",
      status: "pending",
    });
    await expect(repository.isEnrollmentComplete(userId)).resolves.toBe(false);
    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, userId));
    await expect(repository.isEnrollmentComplete(userId)).resolves.toBe(false);
    await db
      .update(workspaceInvites)
      .set({ status: "accepted" })
      .where(eq(workspaceInvites.email, email));
    await expect(repository.isEnrollmentComplete(userId)).resolves.toBe(true);
  });

  it("rejects users whose invite is not pending or accepted", async () => {
    await db
      .insert(workspaceInvites)
      .values({ workspaceId, email, role: "operator", status: "revoked" });
    await expect(repository.findEligibleUser(email)).resolves.toBeNull();
  });

  it("detects only a stored password credential", async () => {
    await expect(repository.hasCredential(userId)).resolves.toBe(false);
    await db.insert(authAccounts).values({
      id: "account_auth_access",
      userId,
      accountId: userId,
      providerId: "credential",
      password: "opaque-hash-for-repository-test",
    });
    await expect(repository.hasCredential(userId)).resolves.toBe(true);
    await expect(repository.hasCredential(otherUserId)).resolves.toBe(false);
  });
  it("increments normalized consecutive failures and locks on the fifth for 15 minutes", async () => {
    await expect(
      repository.recordPasswordFailure(" Admin@Example.com ", now),
    ).resolves.toEqual({
      failedAttempts: 1,
      lockedUntil: null,
    });
    for (let attempt = 2; attempt < 5; attempt += 1) {
      await expect(
        repository.recordPasswordFailure(email, now),
      ).resolves.toEqual({
        failedAttempts: attempt,
        lockedUntil: null,
      });
    }
    const fifthFailure = await repository.recordPasswordFailure(email, now);
    expect(fifthFailure.failedAttempts).toBe(5);
    expect(fifthFailure.lockedUntil?.toISOString()).toBe(
      "2026-07-15T00:15:00.000Z",
    );
    await expect(
      repository.getPasswordGuard(" ADMIN@example.com ", now),
    ).resolves.toEqual(fifthFailure);
  });

  it("resets an expired lock before recording the next failure", async () => {
    await db.insert(passwordLoginGuards).values({
      email,
      failedAttempts: 5,
      lockedUntil: new Date("2026-07-14T23:59:59.999Z"),
      updatedAt: new Date("2026-07-14T23:44:59.999Z"),
    });
    await expect(repository.getPasswordGuard(email, now)).resolves.toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
    await expect(repository.recordPasswordFailure(email, now)).resolves.toEqual(
      { failedAttempts: 1, lockedUntil: null },
    );
  });

  it("clears the password guard after successful login", async () => {
    await repository.recordPasswordFailure(email, now);
    await repository.clearPasswordGuard(" ADMIN@example.com ");
    await expect(repository.getPasswordGuard(email, now)).resolves.toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
  });

  it("atomically completes enrollment for an eligible invite", async () => {
    await db
      .insert(workspaceInvites)
      .values({ workspaceId, email, role: "operator", status: "pending" });
    await repository.recordPasswordFailure(email, now);
    await repository.completeEnrollment(userId, " Admin@Example.com ");

    const [user] = await db
      .select({ verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId));
    const [invite] = await db
      .select({ status: workspaceInvites.status })
      .from(workspaceInvites);
    const guards = await db
      .select()
      .from(passwordLoginGuards)
      .where(eq(passwordLoginGuards.email, email));
    const [audit] = await db
      .select({
        email: authAuditEvents.email,
        userId: authAuditEvents.userId,
        outcome: authAuditEvents.outcome,
        reason: authAuditEvents.reason,
      })
      .from(authAuditEvents)
      .where(eq(authAuditEvents.email, email));
    expect(user).toEqual({ verified: true });
    expect(invite).toEqual({ status: "accepted" });
    expect(guards).toEqual([]);
    expect(audit).toEqual({
      email,
      userId,
      outcome: "success",
      reason: "password_enrollment_completed",
    });
  });

  it("does not partially enroll a user without an eligible invite", async () => {
    await db
      .insert(workspaceInvites)
      .values({ workspaceId, email, role: "operator", status: "revoked" });
    await expect(repository.completeEnrollment(userId, email)).rejects.toThrow(
      /eligible invite/i,
    );
    const [user] = await db
      .select({ verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId));
    const audits = await db
      .select()
      .from(authAuditEvents)
      .where(eq(authAuditEvents.email, email));
    expect(user).toEqual({ verified: false });
    expect(audits).toEqual([]);
  });

  it("revokes all sessions for only the requested user", async () => {
    await db.insert(authSessions).values([
      {
        id: "session_auth_access_1",
        userId,
        token: "token-1",
        expiresAt: new Date("2026-07-16T00:00:00Z"),
      },
      {
        id: "session_auth_access_2",
        userId,
        token: "token-2",
        expiresAt: new Date("2026-07-16T00:00:00Z"),
      },
      {
        id: "session_auth_access_other",
        userId: otherUserId,
        token: "token-other",
        expiresAt: new Date("2026-07-16T00:00:00Z"),
      },
    ]);
    await repository.revokeUserSessions(userId);
    const remaining = await db
      .select({ userId: authSessions.userId })
      .from(authSessions)
      .where(eq(authSessions.userId, otherUserId));
    expect(remaining).toEqual([{ userId: otherUserId }]);
  });

  it("writes normalized, secret-free authentication audit events", async () => {
    await repository.writeAuthAudit({
      email: " Admin@Example.com ",
      userId,
      outcome: "failure",
      reason: "invalid_credentials",
    });
    const [audit] = await db
      .select({
        email: authAuditEvents.email,
        userId: authAuditEvents.userId,
        outcome: authAuditEvents.outcome,
        reason: authAuditEvents.reason,
      })
      .from(authAuditEvents)
      .where(eq(authAuditEvents.email, email));
    expect(audit).toEqual({
      email,
      userId,
      outcome: "failure",
      reason: "invalid_credentials",
    });
  });
});

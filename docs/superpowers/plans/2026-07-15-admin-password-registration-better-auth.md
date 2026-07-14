# Invite-Only Admin Password Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the invited Opak administrator `laichiwillyjp@gmail.com` enroll by verified email and sign in with either a password or magic link using revocable database sessions.

**Architecture:** Replace Auth.js with Better Auth using its Drizzle adapter, dedicated account/session/verification/rate-limit tables, Argon2id password hashing, and the magic-link plugin. Keep workspace invite, membership, lockout, and audit rules in application-owned repositories and put invite-aware wrappers in front of Better Auth's enrollment, password, and magic-link endpoints.

**Tech Stack:** Next.js 16 App Router, React 19, Better Auth, Drizzle ORM 0.44, Neon Postgres, `@node-rs/argon2`, Nodemailer/Resend SMTP, Vitest, Playwright, pnpm 11, Node 24.

## Global Constraints

- Registration is invite-only; the first administrator is `laichiwillyjp@gmail.com`.
- Require inbox control before setting the first password.
- Password length is 12 to 128 characters and hashes use Argon2id.
- Five consecutive password failures lock password login for 15 minutes; magic-link recovery remains available.
- Sessions remain database-backed and password reset revokes all sessions.
- Magic-link signup is disabled; only existing invite-eligible users may authenticate.
- Never log or audit passwords, hashes, raw tokens, SMTP credentials, database URLs, or API keys.
- Preserve unrelated existing worktree changes in `.gitignore`, `apps/web/.gitignore`, and `docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md`.

---

### Task 1: Add the Better Auth database schema and multi-file migration runner

**Files:**
- Create: `packages/db/src/migrations.ts`
- Create: `packages/db/src/migrations.test.ts`
- Create: `packages/db/drizzle/0001_better_auth.sql`
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/schema.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces: `loadSqlMigrations(directory: URL): Promise<Array<{ name: string; sql: string }>>`.
- Produces schema exports: `authAccounts`, `authSessions`, `authVerifications`, `authRateLimits`, `passwordLoginGuards`.
- Preserves `users.legacyEmailVerified` mapped to `email_verified` and adds boolean `users.emailVerified` mapped to `auth_email_verified`.

- [ ] **Step 1: Write the failing migration-loader and schema tests**

```ts
// packages/db/src/migrations.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadSqlMigrations } from "./migrations.js";

it("loads SQL migrations in filename order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wukong-migrations-"));
  await writeFile(join(dir, "0001_second.sql"), "select 2;");
  await writeFile(join(dir, "0000_first.sql"), "select 1;");
  await writeFile(join(dir, "README.md"), "ignored");
  await expect(loadSqlMigrations(pathToFileURL(`${dir}/`))).resolves.toEqual([
    { name: "0000_first.sql", sql: "select 1;" },
    { name: "0001_second.sql", sql: "select 2;" },
  ]);
});
```

Add assertions to `schema.test.ts` that the five new tables expose the columns named in the design and that `users.emailVerified.dataType === "boolean"`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm.cmd --filter @wukong/db test -- migrations.test.ts schema.test.ts`

Expected: FAIL because `loadSqlMigrations` and the Better Auth schema exports do not exist.

- [ ] **Step 3: Implement sorted migration loading**

```ts
// packages/db/src/migrations.ts
import { readdir, readFile } from "node:fs/promises";

export async function loadSqlMigrations(directory: URL) {
  const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, directory), "utf8"),
  })));
}
```

Change `createDatabase().migrate()` in `client.ts` to call `loadSqlMigrations(new URL("../drizzle/", import.meta.url))` and execute each SQL file in its own admin transaction, in sorted order.

- [ ] **Step 4: Add the Drizzle models and idempotent SQL migration**

In `schema.ts`, import `bigint` and `boolean`, retain the legacy timestamp as `legacyEmailVerified`, and add:

```ts
emailVerified: boolean("auth_email_verified").default(false).notNull(),
```

Define the dedicated Better Auth tables using Better Auth's required field names and the physical names `auth_accounts`, `auth_sessions`, `auth_verifications`, and `auth_rate_limits`. Define `password_login_guards` with normalized email primary key, `failedAttempts`, `lockedUntil`, and `updatedAt`.

In `0001_better_auth.sql`, use `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS`; add unique indexes for session token, account provider/account ID, verification identifier/value, and rate-limit key. Grant `SELECT, INSERT, UPDATE, DELETE` on all five new tables to `wukong_app`. Do not drop the legacy Auth.js tables.

- [ ] **Step 5: Run focused tests and migration integration tests**

Run: `pnpm.cmd --filter @wukong/db test -- migrations.test.ts schema.test.ts`

Expected: PASS.

Run: `pnpm.cmd --filter @wukong/db test:integration`

Expected: PASS, including two consecutive calls to `database.migrate()`.

- [ ] **Step 6: Commit Task 1**

```powershell
git add packages/db/src/migrations.ts packages/db/src/migrations.test.ts packages/db/src/client.ts packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/src/index.ts packages/db/drizzle/0001_better_auth.sql
git commit -m "feat: add better auth database schema"
```

---

### Task 2: Add invite, lockout, and audit repositories

**Files:**
- Create: `packages/db/src/repositories/auth-access.ts`
- Create: `packages/db/src/repositories/auth-access.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/seed-opak.test.ts`

**Interfaces:**
- Produces `createAuthAccessRepository(db: AuthDatabase): AuthAccessRepository`.
- `AuthAccessRepository` methods: `findEligibleUser(email)`, `hasCredential(userId)`, `getPasswordGuard(email, now)`, `recordPasswordFailure(email, now)`, `clearPasswordGuard(email)`, `completeEnrollment(userId, email)`, `revokeUserSessions(userId)`, and `writeAuthAudit(event)`.
- `recordPasswordFailure` returns `{ failedAttempts: number; lockedUntil: Date | null }` and locks on attempt five for 15 minutes.

- [ ] **Step 1: Write failing repository contract tests**

Test normalization, eligibility for invite statuses `pending` and `accepted`, rejection of other statuses, attempt increments, fifth-attempt lockout, expired-lock reset, successful-login clear, enrollment acceptance, and session revocation. Use an injected clock fixed at `2026-07-15T00:00:00Z`.

```ts
expect(await guards.recordFailure(" Admin@Example.com ", now)).toEqual({
  failedAttempts: 1,
  lockedUntil: null,
});
expect((await fifthFailure).lockedUntil?.toISOString()).toBe("2026-07-15T00:15:00.000Z");
```

- [ ] **Step 2: Run the repository tests and verify RED**

Run: `pnpm.cmd --filter @wukong/db test -- auth-access.test.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the repository transaction boundaries**

Use `lower(email)` comparisons, parameterized Drizzle SQL, and database transactions. `completeEnrollment` must atomically set `users.auth_email_verified = true`, set eligible invites to `accepted`, clear the login guard, and insert an `auth_audit_events` row with reason `password_enrollment_completed`. `revokeUserSessions` deletes from `auth_sessions` by `user_id`.

- [ ] **Step 4: Update the Opak seed invariant**

Keep `seedOpak` password-free and update its test input to `laichiwillyjp@gmail.com`. Assert the user upsert still contains only `id` and `email`, and the invite remains `pending`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm.cmd --filter @wukong/db test -- auth-access.test.ts seed-opak.test.ts`

Expected: PASS.

```powershell
git add packages/db/src/repositories/auth-access.ts packages/db/src/repositories/auth-access.test.ts packages/db/src/index.ts packages/db/src/seed-opak.test.ts
git commit -m "feat: add invite-aware password access repository"
```

---

### Task 3: Configure Better Auth, Argon2id, SMTP, and the Next.js handler

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/lib/password-crypto.ts`
- Create: `apps/web/lib/password-crypto.test.ts`
- Create: `apps/web/lib/auth-mailer.ts`
- Create: `apps/web/lib/auth-mailer.test.ts`
- Replace: `apps/web/auth.ts`
- Create: `apps/web/auth.test.ts`
- Create: `apps/web/app/api/auth/[...all]/route.ts`
- Delete: `apps/web/app/api/auth/[...nextauth]/route.ts`
- Modify: `apps/web/app/api/auth/auth-route.test.ts`

**Interfaces:**
- Produces `hashPassword(password): Promise<string>` and `verifyPassword(hash, password): Promise<boolean>`.
- Produces `sendAuthEmail({ to, subject, text, html }): Promise<void>`.
- Produces Better Auth instance `auth` and `getAuthDatabase()`.

- [ ] **Step 1: Install dependencies**

Run: `pnpm.cmd --filter @wukong/web add better-auth @better-auth/drizzle-adapter @node-rs/argon2`

Expected: `apps/web/package.json` and `pnpm-lock.yaml` update without peer errors.

- [ ] **Step 2: Write failing crypto and mailer tests**

```ts
it("hashes and verifies passwords without exposing plaintext", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(hash).not.toContain("correct horse");
  await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
  await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
});
```

The mailer test injects `createTransport` and asserts the Resend SMTP URL is used without printing it and that the sender is `AUTH_EMAIL_FROM`.

- [ ] **Step 3: Verify RED, then implement crypto and mailer**

Run: `pnpm.cmd --filter @wukong/web test -- password-crypto.test.ts auth-mailer.test.ts`

Expected: FAIL because both modules are missing.

Implement Argon2id with `@node-rs/argon2` using algorithm Argon2id, version 0x13, memory cost 19,456 KiB, time cost 2, parallelism 1, and output length 32. Validate 12-to-128 characters before hashing. Implement a server-only Nodemailer transport using `AUTH_SMTP_URL` and `AUTH_EMAIL_FROM`.

- [ ] **Step 4: Write the failing Better Auth configuration test**

The test must prove: database sessions are enabled, user/account/session/verification/rate-limit models map to the dedicated Drizzle tables, password hashing delegates to the Argon2 helpers, magic-link signup is disabled, reset and magic-link emails call the mailer, and missing required environment returns the existing controlled 503 shape.

- [ ] **Step 5: Implement Better Auth and handler**

Configure `betterAuth` with:

```ts
emailAndPassword: {
  enabled: true,
  minPasswordLength: 12,
  maxPasswordLength: 128,
  requireEmailVerification: true,
  password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(hash, password) },
  resetPasswordTokenExpiresIn: 60 * 30,
},
session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
rateLimit: { enabled: true, storage: "database", modelName: "authRateLimits" },
plugins: [magicLink({ disableSignUp: true, expiresIn: 60 * 30, sendMagicLink })],
```

Use `drizzleAdapter` with explicit schema mapping to `users`, `authAccounts`, `authSessions`, `authVerifications`, and `authRateLimits`. Export `GET` and `POST` from `toNextJsHandler(auth)` in `[...all]/route.ts`. Preserve the fail-closed 503 route behavior when auth configuration is absent.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm.cmd --filter @wukong/web test -- password-crypto.test.ts auth-mailer.test.ts auth.test.ts auth-route.test.ts`

Expected: PASS.

```powershell
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/password-crypto.ts apps/web/lib/password-crypto.test.ts apps/web/lib/auth-mailer.ts apps/web/lib/auth-mailer.test.ts apps/web/auth.ts apps/web/auth.test.ts apps/web/app/api/auth
git commit -m "feat: replace authjs with better auth"
```

---

### Task 4: Add invite-aware enrollment, password, and magic-link wrappers

**Files:**
- Create: `apps/web/lib/auth-flow.ts`
- Create: `apps/web/lib/auth-flow.test.ts`
- Create: `apps/web/app/api/auth/register/route.ts`
- Create: `apps/web/app/api/auth/password/route.ts`
- Create: `apps/web/app/api/auth/magic-link/route.ts`
- Create: `apps/web/app/api/auth/forgot-password/route.ts`
- Create: `apps/web/app/api/auth/flow-routes.test.ts`

**Interfaces:**
- Produces `createAuthFlow({ auth, access, now })` with `requestEnrollment`, `passwordSignIn`, `requestMagicLink`, and `requestPasswordReset`.
- Every request method returns a generic public result; only successful password authentication forwards Better Auth's `Set-Cookie` headers.

- [ ] **Step 1: Write failing service and route tests**

Cover invited/uninvited enrollment, existing credential rejection with generic response, locked password login, failure increment, fifth failure, successful clear, magic-link eligibility, reset eligibility, safe callback URLs, and no secret fields in responses.

```ts
expect(await flow.requestEnrollment({ email: "unknown@example.com" })).toEqual({ accepted: true });
expect(auth.requestPasswordReset).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm.cmd --filter @wukong/web test -- auth-flow.test.ts flow-routes.test.ts`

Expected: FAIL because the flow and routes do not exist.

- [ ] **Step 3: Implement the flow**

Normalize email once. Enrollment requires an eligible existing user with no credential and forwards to Better Auth's request-password-reset endpoint with `/register/set-password`. Password sign-in checks the per-email guard, forwards the request to Better Auth `/sign-in/email`, records failure for any non-success response, clears on success, and preserves all returned cookies. Magic-link and forgot-password wrappers check eligibility but return the same generic response for all emails.

- [ ] **Step 4: Implement thin route handlers**

Validate request bodies with Zod, reject unsafe callbacks to `/dashboard`, and map validation failures to `{ ok: false, message: "Unable to complete this request." }` without field-level account disclosure.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm.cmd --filter @wukong/web test -- auth-flow.test.ts flow-routes.test.ts`

Expected: PASS.

```powershell
git add apps/web/lib/auth-flow.ts apps/web/lib/auth-flow.test.ts apps/web/app/api/auth/register apps/web/app/api/auth/password apps/web/app/api/auth/magic-link apps/web/app/api/auth/forgot-password apps/web/app/api/auth/flow-routes.test.ts
git commit -m "feat: add invite-only authentication flows"
```

---

### Task 5: Build registration, sign-in, and recovery UI

**Files:**
- Create: `apps/web/components/auth-form.tsx`
- Create: `apps/web/components/auth-form.test.tsx`
- Modify: `apps/web/app/signin/page.tsx`
- Modify: `apps/web/app/signin/page.test.tsx`
- Create: `apps/web/app/register/page.tsx`
- Create: `apps/web/app/register/set-password/page.tsx`
- Create: `apps/web/app/forgot-password/page.tsx`
- Create: `apps/web/app/reset-password/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- `AuthForm` modes: `password-signin`, `magic-link`, `register`, `set-password`, `forgot-password`, `reset-password`.
- Every mode renders labelled controls, inline status with `aria-live="polite"`, disabled submit state, and safe callback propagation.

- [ ] **Step 1: Write failing rendering and interaction tests**

Assert `/signin` contains email/password fields, a password submit button, a magic-link option, registration link, and forgot-password link. Assert register starts with email only; set/reset pages require matching 12-to-128-character passwords; generic success messages do not reveal account existence.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm.cmd --filter @wukong/web test -- auth-form.test.tsx page.test.tsx`

Expected: FAIL because the forms/pages are absent.

- [ ] **Step 3: Implement the client form and pages**

Use `fetch` against the invite-aware wrapper routes, `credentials: "include"`, and `router.push(safeCallback)` only after password login success. Use Better Auth's reset endpoint for token completion. Preserve the Wukong/Opak card design and replace the currently garbled sign-in copy with clear English labels while retaining `Opak Cellar` exactly.

- [ ] **Step 4: Add responsive accessible styles**

Add `.auth-tabs`, `.auth-form`, `.auth-field`, `.auth-status`, and `.auth-links` using the existing color tokens. Inputs must have 44px minimum height, visible focus, error text not conveyed by color alone, and single-column mobile layout.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm.cmd --filter @wukong/web test -- auth-form.test.tsx apps/web/app/signin/page.test.tsx`

Expected: PASS.

```powershell
git add apps/web/components/auth-form.tsx apps/web/components/auth-form.test.tsx apps/web/app/signin apps/web/app/register apps/web/app/forgot-password apps/web/app/reset-password apps/web/app/globals.css
git commit -m "feat: add admin registration and password ui"
```

---

### Task 6: Migrate middleware and server authorization to Better Auth sessions

**Files:**
- Modify: `apps/web/lib/session-context.ts`
- Modify: `apps/web/lib/session-context.test.ts`
- Modify: `apps/web/middleware.ts`
- Create: `apps/web/middleware.test.ts`
- Modify: every test that stubs Auth.js session resolution.

**Interfaces:**
- `resolveAuth` continues to return `{ user?: { id?: string | null } } | null` so downstream membership resolution remains unchanged.
- Better Auth session resolution calls `auth.api.getSession({ headers: await headers() })`.

- [ ] **Step 1: Write failing Better Auth session and cookie tests**

Assert session context reads `session.user.id`, still resolves membership from `auth_get_active_membership`, and middleware recognizes `better-auth.session_token` plus `__Secure-better-auth.session_token`. Assert `/register`, `/forgot-password`, `/reset-password`, and `/api/auth` are public.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm.cmd --filter @wukong/web test -- session-context.test.ts middleware.test.ts`

Expected: FAIL on Auth.js imports and cookie names.

- [ ] **Step 3: Implement the session cutover**

Replace `auth()` with `auth.api.getSession`. Keep database membership lookup through the existing security-definer function. Update comments and cookie detection; do not treat cookie presence as authorization.

- [ ] **Step 4: Run authorization tests and commit**

Run: `pnpm.cmd --filter @wukong/web test -- session-context.test.ts middleware.test.ts route-auth.test.ts`

Expected: PASS.

```powershell
git add apps/web/lib/session-context.ts apps/web/lib/session-context.test.ts apps/web/middleware.ts apps/web/middleware.test.ts apps/web/app/api/route-auth.test.ts
git commit -m "feat: use better auth database sessions"
```

---

### Task 7: Verify the complete feature locally and in database integration

**Files:**
- Create: `tests/admin-password-auth.e2e.spec.ts`
- Modify: `vitest.integration.config.ts` if the new repository test is not already included.
- Modify: `.github/workflows/ci.yml` only if existing integration patterns require the new migration command.

**Interfaces:**
- End-to-end story: invited email request -> emailed enrollment URL fixture -> set password -> password login -> dashboard -> magic-link login -> reset -> old sessions revoked.

- [ ] **Step 1: Add failing integration and browser scenarios**

Use a local SMTP capture/fake mailer dependency and a disposable Postgres database. Assert uninvited registration returns the same public response without creating verification data. Assert the invited flow creates one credential and one active session.

- [ ] **Step 2: Run RED checks**

Run: `pnpm.cmd test:integration`

Run: `pnpm.cmd exec playwright test tests/admin-password-auth.e2e.spec.ts`

Expected: FAIL until all production boundaries are wired.

- [ ] **Step 3: Fix only integration wiring gaps**

Adjust dependency injection, route base URLs, mail capture, or transaction cleanup revealed by the tests. Do not weaken invite checks, token expiry, lockout, or generic errors.

- [ ] **Step 4: Run the full verification suite**

Run: `pnpm.cmd test`

Run: `pnpm.cmd typecheck`

Run: `pnpm.cmd build`

Run: `pnpm.cmd test:integration`

Run: `pnpm.cmd exec playwright test tests/admin-password-auth.e2e.spec.ts`

Expected: all commands PASS. Record unrelated pre-existing failures separately; no new failures may remain.

- [ ] **Step 5: Commit Task 7**

```powershell
git add tests/admin-password-auth.e2e.spec.ts vitest.integration.config.ts .github/workflows/ci.yml
git commit -m "test: verify admin password authentication"
```

---

### Task 8: Migrate, seed, deploy, and verify production

**Files:**
- No source file changes expected.
- Production resources: Neon and the existing Vercel project `wukong-ecommerce-os`.

**Interfaces:**
- Consumes production `DATABASE_URL`, `DATABASE_ADMIN_URL`, `AUTH_SECRET`, `AUTH_SMTP_URL`, and `AUTH_EMAIL_FROM`.
- Uses `OPAK_OPERATOR_EMAIL=laichiwillyjp@gmail.com` only for the seed command; do not persist it unless operationally desired.

- [ ] **Step 1: Obtain explicit approval immediately before production migration and deploy**

State that the migration adds Better Auth tables, the seed changes the invited admin email, and deployment replaces the live Auth.js handler.

- [ ] **Step 2: Apply the idempotent migration and seed**

Run with production credentials injected without printing them:

```powershell
pnpm.cmd --filter @wukong/db db:migrate
pnpm.cmd --filter @wukong/db exec tsx src/seed-opak.ts
```

Expected: both exit 0; a second migration run also exits 0.

- [ ] **Step 3: Push and redeploy the existing project**

Push the verified branch, merge through the approved GitHub workflow, then redeploy the latest `wukong-ecommerce-os` production deployment. Do not create or link another Vercel project.

- [ ] **Step 4: Complete real enrollment**

Open `/register`, submit `laichiwillyjp@gmail.com`, confirm the email contains a 30-minute link, set a compliant password, and verify redirect to `/signin?registered=1`.

- [ ] **Step 5: Verify live behavior and observability**

Verify password login, dashboard access, sign-out, magic-link login, five-failure lockout, magic-link access during lockout, reset, and invalidation of the old session. Check Vercel runtime errors for `/api/auth/*`, confirm no 5xx cluster, and inspect audit rows by stable reason codes without selecting sensitive columns.

- [ ] **Step 6: Final completion commit only if deployment fixes were required**

If no source fixes were required, do not create an empty commit. If fixes were required, repeat the relevant TDD cycle, full verification, and commit with a focused message before redeploying.

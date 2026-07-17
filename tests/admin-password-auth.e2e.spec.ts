import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
test.skip(
  process.env.PLAYWRIGHT_E2E === "1",
  "Auth E2E requires the disposable Postgres/Mailpit stack.",
);

const EMAIL = "laichiwillyjp@gmail.com";
const UNKNOWN = "not-invited@local.invalid";
const OLD_PASSWORD = "Local-only password 1!";
const NEW_PASSWORD = "Local-only password 2!";
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@127.0.0.1:54329/wukong";
const RUNTIME_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong";
const MAILPIT_URL = process.env.TEST_MAILPIT_URL ?? "http://127.0.0.1:8026";
const OPAK_PROFILE = JSON.stringify({
  name: "Opak Cellar",
  currency: "HKD",
  locales: ["en", "zh-Hant"],
  tone: "Knowledgeable, concise, premium, and non-exaggerated.",
  claimPolicy: [
    "ratings require evidence",
    "awards require evidence",
    "exclusivity claims require evidence",
    "health claims are blocked",
    "superlatives require review",
  ],
  requiredFields: [
    "sku",
    "producer",
    "productType",
    "country",
    "volumeMl",
    "abvPercent",
    "priceHkd",
  ],
});
const OPAK_PROMPT =
  "Generate a SHOPLINE listing for Opak Cellar. Use English and Traditional Chinese, with a knowledgeable, concise, premium, non-exaggerated tone. Never invent ratings, awards, exclusivity, health effects, or superlatives; flag unsupported claims for review. Return only the structured listing fields required by the workspace profile.";

type MailpitMessage = {
  ID: string;
  Subject: string;
  To?: Array<{ Address: string }>;
};

async function resetFixture() {
  const db = postgres(ADMIN_URL, { max: 1 });
  try {
    await db`DELETE FROM auth_sessions`;
    await db`DELETE FROM auth_verifications`;
    await db`DELETE FROM auth_rate_limits`;
    await db`DELETE FROM password_login_guards`;
    await db`DELETE FROM auth_accounts`;
    await db`DELETE FROM auth_audit_events`;
    await db`DELETE FROM memberships`;
    await db`DELETE FROM workspace_invites`;
    await db`DELETE FROM users`;
    await db`INSERT INTO workspaces (id, name, profile) VALUES ('ws_opak', 'Opak Cellar', ${OPAK_PROFILE}::jsonb) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, profile = EXCLUDED.profile`;
    await db`INSERT INTO users (id, email) VALUES ('user_opak_operator', ${EMAIL}) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`;
    await db`INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_opak', 'user_opak_operator', 'operator') ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
    await db`INSERT INTO prompt_versions (workspace_id, key, version, template, model) VALUES ('ws_opak', 'listing-generation', '1.0.0', ${OPAK_PROMPT}, 'gpt-5.6-terra') ON CONFLICT (workspace_id, key, version) DO UPDATE SET template = EXCLUDED.template, model = EXCLUDED.model`;
    await db`INSERT INTO workspace_invites (workspace_id, email, role, status) VALUES ('ws_opak', ${EMAIL}, 'operator', 'pending') ON CONFLICT (workspace_id, email) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status`;
  } finally {
    await db.end();
  }
  const response = await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: "DELETE",
  });
  expect(response.ok).toBe(true);
}

async function authState(email: string) {
  const db = postgres(ADMIN_URL, { max: 1 });
  try {
    const [allUsers, verifications, accounts, sessions, invites] =
      await Promise.all([
        db`SELECT id, email, auth_email_verified AS "emailVerified" FROM users`,
        db`SELECT identifier, value FROM auth_verifications`,
        db`SELECT user_id AS "userId", provider_id AS "providerId", password FROM auth_accounts`,
        db`SELECT user_id AS "userId", token FROM auth_sessions`,
        db`SELECT email, status FROM workspace_invites`,
      ]);
    const user = allUsers.find(
      (candidate) => candidate.email.toLowerCase() === email,
    );
    return {
      user: user ?? null,
      verifications: verifications.filter((row) =>
        row.identifier.toLowerCase().includes(email),
      ),
      accounts: user ? accounts.filter((row) => row.userId === user.id) : [],
      sessions: user ? sessions.filter((row) => row.userId === user.id) : [],
      invites: invites.filter((row) => row.email.toLowerCase() === email),
    };
  } finally {
    await db.end();
  }
}

async function latestEmailUrl(
  recipient: string,
  subject: RegExp,
): Promise<string> {
  let message: MailpitMessage | undefined;
  await expect
    .poll(async () => {
      const response = await fetch(`${MAILPIT_URL}/api/v1/messages`);
      if (!response.ok) return false;
      const payload = (await response.json()) as {
        messages?: MailpitMessage[];
      };
      message = payload.messages?.find(
        (candidate) =>
          candidate.To?.some(
            (entry) => entry.Address.toLowerCase() === recipient,
          ) && subject.test(candidate.Subject),
      );
      return Boolean(message);
    })
    .toBe(true);
  const detail = (await fetch(
    `${MAILPIT_URL}/api/v1/message/${message!.ID}`,
  ).then((response) => response.json())) as { Text?: string; HTML?: string };
  const match = `${detail.Text ?? ""}\n${detail.HTML ?? ""}`.match(
    /https?:\/\/[^\s<>"']+/,
  );
  expect(
    match,
    "captured email contains a controlled completion URL",
  ).toBeTruthy();
  return match![0].replaceAll("&amp;", "&");
}

async function submitEmail(page: Page, email: string, button: string) {
  await page.getByLabel("Email address").fill(email);
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/auth/"),
  );
  await page.getByRole("button", { name: button }).click();
  return pending;
}

/**
 * Mailpit captures Better Auth's real token URL. Only its origin is rewritten
 * from Better Auth's configured public origin to this deterministic local server.
 */
async function followCapturedUrl(page: Page, captured: string) {
  const url = new URL(captured);
  const base = new URL(String(test.info().project.use.baseURL));
  url.protocol = base.protocol;
  url.host = base.host;
  await page.goto(url.toString());
}

test.beforeAll(async () => {
  await execFileAsync("pnpm.cmd", ["--filter", "@wukong/db", "db:migrate"], {
    cwd: process.cwd(),
    shell: true,
    env: {
      ...process.env,
      DATABASE_URL: RUNTIME_URL,
      DATABASE_ADMIN_URL: ADMIN_URL,
    },
  });
});
test.beforeEach(async () => {
  await resetFixture();
});
test("complete invited-admin password authentication story", async ({
  page,
  request,
  context,
}) => {
  await page.goto("/register?callbackUrl=%2Fdashboard");
  await expect(
    page.getByRole("heading", { name: "Request admin access" }),
  ).toBeVisible();

  const denied = await submitEmail(page, UNKNOWN, "Send registration email");
  expect(denied.status()).toBe(200);
  const deniedBody = await denied.json();
  await expect(
    page.getByText(
      "If this address is eligible, an email will arrive shortly.",
    ),
  ).toBeVisible();
  expect(await authState(UNKNOWN)).toEqual({
    user: null,
    verifications: [],
    accounts: [],
    sessions: [],
    invites: [],
  });

  const allowed = await submitEmail(page, EMAIL, "Send registration email");
  expect(allowed.status()).toBe(200);
  expect(await allowed.json()).toEqual(deniedBody);
  expect(JSON.stringify(deniedBody)).not.toMatch(/token|password|hash|secret/i);

  const enrollmentUrl = await latestEmailUrl(
    EMAIL,
    /reset your wukong password/i,
  );
  expect(decodeURIComponent(enrollmentUrl)).toContain("/register/set-password");
  await followCapturedUrl(page, enrollmentUrl);
  await expect(
    page.getByRole("heading", { name: "Create your password" }),
  ).toBeVisible();
  const enrollmentToken = new URL(page.url()).searchParams.get("token");
  expect(enrollmentToken).toBeTruthy();
  await page.getByLabel("Password", { exact: true }).fill(OLD_PASSWORD);
  await page.getByLabel("Confirm password").fill(OLD_PASSWORD);
  const completion = page.waitForResponse((response) =>
    response.url().includes("/api/auth/reset-password"),
  );
  await page.getByRole("button", { name: "Create password" }).click();
  expect((await completion).status()).toBe(200);
  await expect(page).toHaveURL(/\/signin\?registered=1/);

  const replay = await request.post("/api/auth/reset-password", {
    data: { newPassword: "Replay must not work 1!", token: enrollmentToken },
  });
  expect(replay.ok()).toBe(false);

  const enrolled = await authState(EMAIL);
  expect(enrolled.user?.emailVerified).toBe(true);
  expect(enrolled.invites).toHaveLength(1);
  expect(enrolled.invites[0]?.status).toBe("accepted");
  expect(
    enrolled.accounts.filter((row) => row.providerId === "credential"),
  ).toHaveLength(1);
  const originalHash = enrolled.accounts[0]?.password;
  expect(originalHash).toMatch(/^\$argon2id\$/);
  const auditDb = postgres(ADMIN_URL, { max: 1 });
  const audits =
    await auditDb`SELECT reason FROM auth_audit_events WHERE email = ${EMAIL}`;
  await auditDb.end();
  expect(audits.map((row) => row.reason)).toEqual(
    expect.arrayContaining([
      "password_enrollment_requested",
      "password_enrollment_completed",
    ]),
  );

  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(OLD_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator("body")).toContainText("Opak Cellar");
  expect(
    (await context.cookies()).some((cookie) =>
      cookie.name.includes("better-auth.session_token"),
    ),
  ).toBe(true);
  expect((await authState(EMAIL)).sessions).toHaveLength(1);
  const session = await page.request.get("/api/auth/get-session");
  expect(session.ok()).toBe(true);
  expect((await session.json()).user.email).toBe(EMAIL);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const failure = await request.post("/api/auth/password", {
      data: {
        email: EMAIL,
        password: "Definitely wrong 1!",
        callbackURL: "/dashboard",
      },
    });
    expect(failure.status()).toBe(401);
    expect(JSON.stringify(await failure.json())).not.toMatch(
      /token|hash|secret|argon/i,
    );
  }
  const guardDb = postgres(ADMIN_URL, { max: 1 });
  const guards =
    await guardDb`SELECT email, failed_attempts AS "failedAttempts", locked_until AS "lockedUntil" FROM password_login_guards`;
  await guardDb.end();
  expect(guards.find((guard) => guard.email === EMAIL)).toMatchObject({
    failedAttempts: 5,
  });
  expect(
    guards.find((guard) => guard.email === EMAIL)?.lockedUntil,
  ).toBeInstanceOf(Date);

  await page.goto("/signin");
  await page.getByRole("button", { name: "Magic link" }).click();
  expect(
    (await submitEmail(page, EMAIL, "Email me a magic link")).status(),
  ).toBe(200);
  await followCapturedUrl(page, await latestEmailUrl(EMAIL, /sign-in link/i));
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto("/forgot-password?callbackUrl=%2Fdashboard");
  expect((await submitEmail(page, EMAIL, "Send reset email")).status()).toBe(
    200,
  );
  const resetUrl = await latestEmailUrl(EMAIL, /reset your wukong password/i);
  expect(decodeURIComponent(resetUrl)).toContain("/reset-password");
  await followCapturedUrl(page, resetUrl);
  await expect(
    page.getByRole("heading", { name: "Choose a new password" }),
  ).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/signin\?reset=1/);

  const reset = await authState(EMAIL);
  expect(reset.sessions).toHaveLength(0);
  expect(reset.accounts).toHaveLength(1);
  expect(reset.accounts[0]?.password).toMatch(/^\$argon2id\$/);
  expect(reset.accounts[0]?.password).not.toBe(originalHash);
  expect(
    (
      await request.post("/api/auth/password", {
        data: { email: EMAIL, password: OLD_PASSWORD },
      })
    ).ok(),
  ).toBe(false);
  expect(
    (
      await request.post("/api/auth/password", {
        data: { email: EMAIL, password: NEW_PASSWORD },
      })
    ).ok(),
  ).toBe(true);
});

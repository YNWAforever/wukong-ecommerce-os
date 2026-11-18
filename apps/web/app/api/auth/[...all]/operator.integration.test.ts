import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthDatabase, createDatabase } from "@wukong/db";

import {
  createAuthInstance,
  createOperatorAuthInstance,
  type AuthDependencies,
} from "../../../../auth";

const runtimeUrl = process.env.TEST_DATABASE_URL!;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
const email = `ops-${crypto.randomUUID()}@example.test`;

describe("workspace-free operator magic link", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const migration = createDatabase(adminUrl, { migrationUrl: adminUrl });
  const db = createAuthDatabase(runtimeUrl);
  let operator: ReturnType<typeof createOperatorAuthInstance>;
  const sent: string[] = [];

  beforeAll(async () => {
    await migration.migrate();
    const dependencies: AuthDependencies = {
      createAdapter: drizzleAdapter as never,
      createMagicLink: magicLink as never,
      sendEmail: async ({ text }) => {
        sent.push(text);
      },
    };
    operator = createOperatorAuthInstance(
      db,
      {
        secret: "integration-operator-secret-at-least-32-characters",
        databaseUrl: runtimeUrl,
        smtpUrl: "smtp://127.0.0.1:1025",
        from: "Wukong <auth@example.test>",
        baseUrl: "http://localhost:3000",
      },
      dependencies,
    );
  });

  afterAll(async () => {
    await admin`delete from auth_verifications where identifier = ${email}`;
    await admin`delete from users where email = ${email}`;
    await db.close();
    await migration.close();
    await admin.end();
  });

  it("creates the account on the emailed link and signs it in without a membership", async () => {
    const request = new Request(
      "http://localhost:3000/api/auth/sign-in/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          callbackURL: "/ops/pilot-leads",
        }),
      },
    );
    const response = await operator.handler(request);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const url = sent[0]!.match(/https?:\/\/\S+/)?.[0];
    expect(url).toBeTruthy();

    const verify = await operator.handler(new Request(url!));
    expect([200, 302]).toContain(verify.status);
    expect(verify.headers.get("location")).toContain("/ops/pilot-leads");
    const cookie = verify.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain("session_token");

    const session = await operator.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe(email);

    // The console uses the normal auth instance; the shared secret and session
    // table must resolve the cookie issued by the operator instance.
    const standard = createAuthInstance(db, {
      secret: "integration-operator-secret-at-least-32-characters",
      databaseUrl: runtimeUrl,
      smtpUrl: "smtp://127.0.0.1:1025",
      from: "Wukong <auth@example.test>",
      baseUrl: "http://localhost:3000",
    });
    const standardSession = await standard.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(standardSession?.user.email).toBe(email);

    const [user] = await admin<
      { id: string; verified: boolean }[]
    >`select id, auth_email_verified as verified from users where email = ${email}`;
    expect(user?.verified).toBe(true);
    if (!user) throw new Error("operator user was not created");
    const memberships = await admin<
      { count: number }[]
    >`select count(*)::int as count from memberships where user_id = ${user.id}`;
    expect(memberships[0]?.count).toBe(0);
  });
});

import postgres from "postgres";
import { hash } from "@node-rs/argon2";

/**
 * Local-only seed for the flags-on Conversation Studio browser acceptance.
 * Not imported by the app; run once against the disposable local `wukong`
 * database, then delete. Prints ids only (never the password or its hash).
 */

const DATABASE_URL =
  process.env.BROWSER_E2E_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@127.0.0.1:54329/wukong";
const WORKSPACE_ID = "ws_studio_browser_e2e";
const USER_ID = "user_studio_browser_e2e";
const EMAIL = "studio-browser-e2e@local.invalid";
const PASSWORD = "Local-only studio browser password 1!";

const ARGON2_OPTIONS = {
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

const sql = postgres(DATABASE_URL, { max: 1 });
try {
  const passwordHash = await hash(PASSWORD, ARGON2_OPTIONS);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM studio_workspace_settings WHERE workspace_id = ${WORKSPACE_ID}`;
    await tx`DELETE FROM workspace_invites WHERE workspace_id = ${WORKSPACE_ID}`;
    await tx`DELETE FROM auth_accounts WHERE user_id = ${USER_ID} OR account_id = ${USER_ID}`;
    await tx`DELETE FROM memberships WHERE user_id = ${USER_ID}`;
    await tx`DELETE FROM users WHERE id = ${USER_ID}`;
    await tx`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`;
    await tx`INSERT INTO workspaces (id, name, profile) VALUES (${WORKSPACE_ID}, 'Studio Browser E2E', ${sql.json({ name: "Studio Browser E2E" })})`;
    await tx`INSERT INTO users (id, email, name, auth_email_verified) VALUES (${USER_ID}, ${EMAIL}, 'Studio Browser E2E', true)`;
    await tx`INSERT INTO workspace_invites (workspace_id, email, role, status) VALUES (${WORKSPACE_ID}, ${EMAIL}, 'admin', 'accepted')`;
    await tx`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
    await tx`INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password) VALUES ('acct_studio_browser_e2e', ${USER_ID}, ${USER_ID}, 'credential', ${passwordHash})`;
    await tx`INSERT INTO studio_workspace_settings (workspace_id, enabled, updated_by) VALUES (${WORKSPACE_ID}, true, ${USER_ID})`;
  });
  console.log(
    JSON.stringify({
      event: "studio_browser_e2e_seeded",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      email: EMAIL,
      studioEnabled: true,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}

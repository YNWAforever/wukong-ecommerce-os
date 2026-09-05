import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "../../packages/db/src/client.js";
import { hashPassword } from "../../apps/web/lib/password-crypto.js";
import postgres from "postgres";

import { S3AssetStore } from "../../packages/assets/src/s3-asset-store.js";
import { verifyAudit } from "../../packages/db/src/cli/audit-verify.js";
import { runPnpm } from "./run-pnpm.js";

export const OPAK_WORKSPACE_ID = "ws_opak";
export const OPAK_ADMIN_EMAIL = "opak-admin-e2e@local.invalid";
export const OPAK_ADMIN_PASSWORD = "Local-only admin password 1!";
export const OPAK_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
export const FOREIGN_WORKSPACE_ID = "ws_foreign_e2e";

export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@127.0.0.1:54329/wukong";
export const RUNTIME_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong";
const MAILPIT_URL = process.env.TEST_MAILPIT_URL ?? "http://127.0.0.1:8026";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:49217";
const S3_BUCKET = process.env.S3_BUCKET ?? "wukong-local";
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9010";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "wukong";
const S3_SECRET_ACCESS_KEY =
  process.env.S3_SECRET_ACCESS_KEY ?? "wukong-secret";

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

function s3Client() {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
}

async function resetBucket(client: S3Client) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(name)) throw error;
  }
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: S3_BUCKET }),
  );
  if (listed.Contents?.length) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: {
          Objects: listed.Contents.flatMap((entry) =>
            entry.Key ? [{ Key: entry.Key }] : [],
          ),
        },
      }),
    );
  }
}

async function ensureRuntimeRole() {
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
        CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END $$;`);
  } finally {
    await admin.end();
  }
}

export async function prepareRealStackFixture() {
  await ensureRuntimeRole();
  await runPnpm(["--filter", "@wukong/db", "db:migrate"], {
    ...process.env,
    DATABASE_URL: RUNTIME_URL,
    DATABASE_ADMIN_URL: ADMIN_URL,
  });
  await resetBucket(s3Client());

  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`DELETE FROM auth_sessions`;
    await admin`DELETE FROM auth_verifications`;
    await admin`DELETE FROM auth_rate_limits`;
    await admin`DELETE FROM password_login_guards`;
    await admin`DELETE FROM auth_accounts`;
    await admin`DELETE FROM auth_audit_events`;
    await admin`DELETE FROM workspaces WHERE id IN (${OPAK_WORKSPACE_ID}, ${FOREIGN_WORKSPACE_ID})`;
    await admin`DELETE FROM users WHERE email = ${OPAK_ADMIN_EMAIL}`;
    await admin`INSERT INTO workspaces (id, name, profile) VALUES (${OPAK_WORKSPACE_ID}, 'Opak Cellar', ${OPAK_PROFILE}::jsonb)`;
    await admin`INSERT INTO users (id, email) VALUES ('user_opak_admin_e2e', ${OPAK_ADMIN_EMAIL})`;
    await admin`INSERT INTO memberships (workspace_id, user_id, role) VALUES (${OPAK_WORKSPACE_ID}, 'user_opak_admin_e2e', 'admin')`;
    await admin`INSERT INTO prompt_versions (workspace_id, key, version, template, model) VALUES (${OPAK_WORKSPACE_ID}, 'listing-generation', '1.0.0', ${OPAK_PROMPT}, 'gpt-5.6-terra')`;
    await admin`INSERT INTO workspace_invites (workspace_id, email, role, status) VALUES (${OPAK_WORKSPACE_ID}, ${OPAK_ADMIN_EMAIL}, 'admin', 'pending')`;
    await admin`INSERT INTO shopline_connections (id, workspace_id, shop_domain, encrypted_access_token) VALUES (${OPAK_CONNECTION_ID}, ${OPAK_WORKSPACE_ID}, 'opak-cellar.mock.shopline.test', 'mock-e2e-token')`;

    await admin`INSERT INTO workspaces (id, name, profile) VALUES (${FOREIGN_WORKSPACE_ID}, 'Foreign tenant', '{}'::jsonb)`;
    await admin`INSERT INTO listing_drafts (workspace_id, target, note) VALUES (${FOREIGN_WORKSPACE_ID}, 'shopline', 'foreign probe')`;
  } finally {
    await admin.end();
  }

  const mailReset = await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: "DELETE",
  });
  expect(mailReset.ok).toBe(true);
}

type MailpitMessage = {
  ID: string;
  Subject: string;
  To?: Array<{ Address: string }>;
};

async function latestEmailUrl(recipient: string): Promise<string> {
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
          ) && /reset your wukong password/i.test(candidate.Subject),
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
  expect(match).toBeTruthy();
  return match![0].replaceAll("&amp;", "&");
}

export async function enrollAndSignInOpakAdmin(page: Page) {
  await page.goto("/register?callbackUrl=%2Flistings%2Fnew");
  // The auth pages default to zh-Hant when no locale cookie is set (a real,
  // intentional product default -- see docs/superpowers/specs/2026-09-02-
  // package-c-public-entry-auth-layout-design.md). This fixture's own
  // assertions are pinned to English copy, so it must pin the browser to
  // English explicitly (via the same cookie the app itself reads) rather
  // than depend on the app's default, then reload to pick it up.
  await page.evaluate(() => {
    document.cookie = "locale=en; path=/; max-age=31536000";
  });
  await page.reload();
  await page.getByLabel("Email address").fill(OPAK_ADMIN_EMAIL);
  await page.getByRole("button", { name: "Send registration email" }).click();
  await expect(
    page.getByText(
      "If this address is eligible, an email will arrive shortly.",
    ),
  ).toBeVisible();

  const enrollment = new URL(await latestEmailUrl(OPAK_ADMIN_EMAIL));
  const base = new URL(BASE_URL);
  enrollment.protocol = base.protocol;
  enrollment.host = base.host;
  await page.goto(enrollment.toString());
  await page
    .getByLabel("New password", { exact: true })
    .fill(OPAK_ADMIN_PASSWORD);
  await page.getByLabel("Confirm new password").fill(OPAK_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Create password" }).click();
  await expect(page).toHaveURL(/\/signin\?registered=1/);

  await page.getByLabel("Email address").fill(OPAK_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(OPAK_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/listings\/new$/);
}

export async function verifyUploadedAsset(draftId: string) {
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  let key = "";
  try {
    const [row] = await admin<
      Array<{ storageKey: string; size: number; mimeType: string }>
    >`SELECT storage_key AS "storageKey",
             (metadata->>'size')::int AS size,
             metadata->>'mimeType' AS "mimeType"
      FROM source_assets
      WHERE workspace_id = ${OPAK_WORKSPACE_ID} AND listing_id = ${draftId}
      ORDER BY created_at
      LIMIT 1`;
    expect(row).toBeTruthy();
    key = row!.storageKey;
    const client = s3Client();
    const head = await client.send(
      new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    );
    expect(head.ContentLength).toBe(row!.size);
    expect(head.ContentType).toBe(row!.mimeType);
  } finally {
    await admin.end();
  }

  const store = S3AssetStore.fromConfig(S3_BUCKET, {
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
  const read = await store.createReadUrl(OPAK_WORKSPACE_ID, key);
  const response = await fetch(read.url);
  expect(response.ok).toBe(true);
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
}

export function expectedMockShoplineRemoteId(versionId: string): string {
  const idempotencyKey = `${OPAK_WORKSPACE_ID}:${versionId}:shopline:create`;
  return `mock_${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 16)}`;
}

export async function verifyCompletedAudit(draftId: string) {
  return verifyAudit({
    workspaceId: OPAK_WORKSPACE_ID,
    draftId,
    url: RUNTIME_URL,
  });
}

/** The import journey uses the real database/auth boundary, without Queue, mail or asset services. */
export async function prepareBulkImportFixture() {
  for (const raw of [ADMIN_URL, RUNTIME_URL]) {
    const url = new URL(raw);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error(
        "Bulk import browser fixtures require isolated local database URLs",
      );
  }
  await ensureRuntimeRole();
  const database = createDatabase(RUNTIME_URL, { migrationUrl: ADMIN_URL });
  try {
    await database.migrate();
  } finally {
    await database.close();
  }
  const suffix = randomUUID();
  const workspaceId = "ws_import_" + suffix.replaceAll("-", "");
  const userId = "user_import_" + suffix;
  const email = "bulk-import-" + suffix + "@local.invalid";
  const password = "Synthetic import password 1!";
  const connectionId = randomUUID();
  const passwordHash = await hashPassword(password);
  const admin = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    await admin`INSERT INTO workspaces (id,name,profile) VALUES (${workspaceId},'Synthetic import workspace',${OPAK_PROFILE}::jsonb)`;
    await admin`INSERT INTO users(id,email,auth_email_verified) VALUES (${userId},${email},true)`;
    await admin`INSERT INTO memberships(workspace_id,user_id,role) VALUES (${workspaceId},${userId},'operator')`;
    await admin`INSERT INTO workspace_invites(workspace_id,email,role,status) VALUES (${workspaceId},${email},'operator','accepted')`;
    await admin`INSERT INTO auth_accounts(id,user_id,account_id,provider_id,password) VALUES (${randomUUID()},${userId},${userId},'credential',${passwordHash})`;
  } finally {
    await admin.end();
  }
  return { workspaceId, userId, email, password, connectionId };
}

export async function signInBulkImportOperator(
  page: Page,
  fixture: Awaited<ReturnType<typeof prepareBulkImportFixture>>,
) {
  await page.goto("/signin?callbackUrl=%2Flistings%2Fimport");
  await page.evaluate(() => {
    document.cookie = "locale=en; path=/; max-age=31536000";
  });
  await page.reload();
  await page.getByLabel("Email address").fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/listings\/import$/);
}

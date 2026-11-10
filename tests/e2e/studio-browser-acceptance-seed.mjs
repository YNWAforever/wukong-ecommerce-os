import { createRequire } from "node:module";

/**
 * Resolve the two fixture dependencies through `apps/web`, which already
 * depends on both (`postgres` and `@node-rs/argon2`). The repository root has
 * neither as a direct dependency, so a plain `node tests/e2e/...` run from the
 * root (as both the runbook and CI do) cannot resolve them from the script's
 * own directory. Going through the owning package keeps the committed
 * dependency graph unchanged while making the seed runnable as written.
 */
const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const postgresModule = requireFromWeb("postgres");
const postgres = postgresModule.default ?? postgresModule;
const { hash } = requireFromWeb("@node-rs/argon2");

/**
 * Idempotent seed for the flags-on Conversation Studio browser acceptance.
 *
 * Not imported by the app; run once against a disposable local (or the CI
 * job's migrated) `wukong` database, then throw it away. Repeating it is safe:
 * the workspace, user, membership and Studio-settings rows are upserted, and
 * only the invite-eligibility and credential rows are replaced. It never
 * deletes the workspace, because the Studio message/run tables are append-only
 * by trigger and a delete cascade from a previous run would raise. Prints ids
 * only (never the password or its hash).
 *
 * Connection precedence: `BROWSER_E2E_DATABASE_ADMIN_URL` (local convention),
 * then `DATABASE_ADMIN_URL` (the CI job already sets this), then the disposable
 * local default. Only ever point it at a disposable database.
 */

export const STUDIO_BROWSER_ACCEPTANCE_WORKSPACE_ID = "ws_studio_browser_e2e";
export const STUDIO_BROWSER_ACCEPTANCE_USER_ID = "user_studio_browser_e2e";
export const STUDIO_BROWSER_ACCEPTANCE_EMAIL =
  "studio-browser-e2e@local.invalid";
/** Local-only fixture password; matches the committed Playwright spec. */
export const STUDIO_BROWSER_ACCEPTANCE_PASSWORD =
  "Local-only studio browser password 1!";
/**
 * Fixed synthetic listing linked to a bulk-form workbook row, so the
 * deterministic supplier-intel finding can be exercised through the browser.
 * The spec duplicates these ids (it must not import this module: running the
 * seed as a module side effect from Playwright would touch the database).
 */
export const STUDIO_BROWSER_ACCEPTANCE_SUPPLIER_LISTING_ID =
  "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a01";
const SUPPLIER_LISTING_ID = STUDIO_BROWSER_ACCEPTANCE_SUPPLIER_LISTING_ID;
const SUPPLIER_VERSION_ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a02";
const SUPPLIER_CONNECTION_ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a03";
const SUPPLIER_IMPORT_ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a04";
const SUPPLIER_PRODUCT_ID = "5b16a8c2-8f6e-4e57-9b1e-1f0f0b6f7a05";
const SUPPLIER_RAW_ROW = {
  supplier: "Demo Supplier Ltd",
  brand: "Chateau Demo",
  sku: "E2E-SUP-001",
  barcode: "",
  mpn: null,
  productCost: "120.0",
  tradePrice: "150.0",
  nameEn: "Supplier-linked wine",
  nameZh: "供應商連結酒",
};
/**
 * `facts_prefill` is parsed by `listingFactsSchema` on every read, so it must be
 * a complete facts object (nullable fields present), not an empty object.
 */
const SUPPLIER_FACTS_PREFILL = {
  sku: "E2E-SUP-001",
  producer: null,
  productType: "wine",
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
};
const SUPPLIER_LISTING_CONTENT = {
  sku: "E2E-SUP-001",
  producer: null,
  productType: "wine",
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "Supplier-linked wine", "zh-Hant": "供應商連結酒" },
  description: {
    en: "Synthetic supplier fixture",
    "zh-Hant": "合成供應商測試資料",
  },
  seo: {
    title: { en: "Supplier-linked wine", "zh-Hant": "供應商連結酒" },
    description: {
      en: "Synthetic supplier fixture",
      "zh-Hant": "合成供應商測試資料",
    },
  },
  tags: [],
  imageAssetIds: [],
};

const WORKSPACE_ID = STUDIO_BROWSER_ACCEPTANCE_WORKSPACE_ID;
const USER_ID = STUDIO_BROWSER_ACCEPTANCE_USER_ID;
const EMAIL = STUDIO_BROWSER_ACCEPTANCE_EMAIL;
const PASSWORD = STUDIO_BROWSER_ACCEPTANCE_PASSWORD;

const DATABASE_URL =
  process.env.BROWSER_E2E_DATABASE_ADMIN_URL ??
  process.env.DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@127.0.0.1:54329/wukong";

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
  const supplierListingContentJson = sql.json(SUPPLIER_LISTING_CONTENT);
  const supplierRawRowJson = sql.json(SUPPLIER_RAW_ROW);
  const supplierFactsPrefillJson = sql.json(SUPPLIER_FACTS_PREFILL);
  const sha256 = (character) => character.repeat(64);
  await sql.begin(async (tx) => {
    // Upsert rather than delete-and-recreate: the Studio message/run tables
    // are append-only by trigger, so deleting this workspace after a previous
    // acceptance run would raise and the seed would stop being idempotent.
    // Only rows that are safe to replace (invite eligibility and the
    // credential account) are deleted.
    await tx`
      INSERT INTO workspaces (id, name, profile)
      VALUES (${WORKSPACE_ID}, 'Studio Browser E2E', ${sql.json({ name: "Studio Browser E2E" })})
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, profile = excluded.profile
    `;
    await tx`
      INSERT INTO users (id, email, name, auth_email_verified)
      VALUES (${USER_ID}, ${EMAIL}, 'Studio Browser E2E', true)
      ON CONFLICT (id) DO UPDATE SET
        email = excluded.email, name = excluded.name, auth_email_verified = true
    `;
    await tx`DELETE FROM workspace_invites WHERE workspace_id = ${WORKSPACE_ID}`;
    await tx`INSERT INTO workspace_invites (workspace_id, email, role, status) VALUES (${WORKSPACE_ID}, ${EMAIL}, 'admin', 'accepted')`;
    await tx`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role
    `;
    await tx`DELETE FROM auth_accounts WHERE user_id = ${USER_ID} OR account_id = ${USER_ID}`;
    await tx`INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password) VALUES ('acct_studio_browser_e2e', ${USER_ID}, ${USER_ID}, 'credential', ${passwordHash})`;
    await tx`
      INSERT INTO studio_workspace_settings (workspace_id, enabled, updated_by)
      VALUES (${WORKSPACE_ID}, true, ${USER_ID})
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled = true, updated_by = excluded.updated_by, updated_at = now()
    `;

    // Supplier-intel fixture: a listing whose canonical bulk-form row and
    // source-import receipt are linked, exactly the shape the importer writes.
    await tx`
      INSERT INTO shopline_connections (id, workspace_id, shop_domain, encrypted_access_token)
      VALUES (${SUPPLIER_CONNECTION_ID}, ${WORKSPACE_ID}, 'studio-supplier-e2e.local', 'fixture-not-a-token')
      ON CONFLICT (id) DO UPDATE SET updated_at = now()
    `;
    await tx`
      INSERT INTO source_imports (id, workspace_id, connection_id, filename, workbook_sha256, header_contract_sha256, sheet_name, row_count, merchant_attested_export_at, importer_id, spec_version)
      VALUES (
        ${SUPPLIER_IMPORT_ID}, ${WORKSPACE_ID}, ${SUPPLIER_CONNECTION_ID},
        'studio-supplier-e2e.xlsx', ${sha256("a")}, ${sha256("b")},
        'Products', 1, now(), ${USER_ID}, 'wukong-bulk-form/v1'
      )
      ON CONFLICT (id) DO UPDATE SET filename = excluded.filename
    `;
    await tx`
      INSERT INTO listing_drafts (id, workspace_id, target, status, note)
      VALUES (${SUPPLIER_LISTING_ID}, ${WORKSPACE_ID}, 'shopline', 'in_review', 'Studio supplier e2e fixture')
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status, note = excluded.note
    `;
    await tx`
      INSERT INTO listing_versions (id, workspace_id, listing_id, sequence, content, created_by)
      VALUES (${SUPPLIER_VERSION_ID}, ${WORKSPACE_ID}, ${SUPPLIER_LISTING_ID}, 1, ${supplierListingContentJson}, ${USER_ID})
      ON CONFLICT (listing_id, sequence) DO UPDATE SET content = excluded.content
    `;
    await tx`
      UPDATE listing_drafts SET active_version_id = ${SUPPLIER_VERSION_ID}
      WHERE id = ${SUPPLIER_LISTING_ID} AND workspace_id = ${WORKSPACE_ID}
    `;
    await tx`
      INSERT INTO platform_products (id, workspace_id, connection_id, remote_product_id, sku, listing_id, spec_version, raw_row, facts_prefill, content_digest, origin, source_import_id)
      VALUES (
        ${SUPPLIER_PRODUCT_ID}, ${WORKSPACE_ID}, ${SUPPLIER_CONNECTION_ID},
        'e2e-supplier-product', 'E2E-SUP-001', ${SUPPLIER_LISTING_ID},
        'wukong-bulk-form/v1', ${supplierRawRowJson}, ${supplierFactsPrefillJson},
        ${sha256("c")}, 'import', ${SUPPLIER_IMPORT_ID}
      )
      ON CONFLICT (id) DO UPDATE SET
        raw_row = excluded.raw_row,
        facts_prefill = excluded.facts_prefill,
        listing_id = excluded.listing_id,
        origin = excluded.origin,
        source_import_id = excluded.source_import_id
    `;
  });
  console.log(
    JSON.stringify({
      event: "studio_browser_e2e_seeded",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      email: EMAIL,
      studioEnabled: true,
      supplierListingId: SUPPLIER_LISTING_ID,
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}

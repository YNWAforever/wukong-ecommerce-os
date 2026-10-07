import type postgres from "postgres";

export type SchemaInventory = {
  migrations: Record<string, boolean>;
  missing: string[];
  wukongAppRole: boolean;
  currentUser: string;
  counts: {
    listing_drafts: number;
    listing_versions: number;
    listing_pipeline_runs: number;
  };
  appGrants: Record<string, boolean>;
};

const GRANT_TABLES = [
  "listing_assignments",
  "listing_quality_assessments",
  "workspace_quality_summaries",
  "enrichment_batch_previews",
] as const;

const appGrant = (table: string) =>
  `CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wukong_app') AND to_regclass('public.${table}') IS NOT NULL THEN has_table_privilege('wukong_app', 'public.${table}', 'SELECT') ELSE false END AS "grant_${table}"`;

// Catalog reads and three row counts only. One marker object per migration
// 0041-0053; it never reads listing content and never writes.
export const SCHEMA_INVENTORY_SQL = String.raw`
SELECT
  to_regclass('public.wine_stages') IS NOT NULL AS "m0041",
  to_regclass('public.wine_evidence_cache') IS NOT NULL AS "m0042",
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sweeper_find_abandoned_wine_operations') AS "m0043",
  to_regclass('public.wine_sections_run_idx') IS NOT NULL AS "m0044",
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_runs' AND column_name = 'estimated_cost_usd' AND is_nullable = 'YES') AS "m0045",
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listing_versions' AND column_name = 'source_import_id') AS "m0046",
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_complete_enrollment') AS "m0047",
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_get_active_membership') AS "m0048",
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'enrichment_batch_items' AND column_name = 'content_fence') AS "m0049",
  to_regclass('public.enrichment_batch_previews') IS NOT NULL AS "m0050",
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'enrichment_batches' AND column_name = 'archived_at') AS "m0051",
  to_regclass('public.listing_assignments') IS NOT NULL AS "m0052",
  to_regclass('public.listing_quality_assessments') IS NOT NULL AS "m0053",
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wukong_app') AS "wukong_app_role",
  current_user AS "current_user",
  (SELECT count(*) FROM listing_drafts) AS "count_listing_drafts",
  (SELECT count(*) FROM listing_versions) AS "count_listing_versions",
  (SELECT count(*) FROM listing_pipeline_runs) AS "count_listing_pipeline_runs",
  ${GRANT_TABLES.map(appGrant).join(",\n  ")}`;

export async function inspectSchemaInventory(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
): Promise<SchemaInventory> {
  const [row = {}] = await query(SCHEMA_INVENTORY_SQL);
  const migrations: Record<string, boolean> = {};
  for (let number = 41; number <= 53; number++) {
    const key = String(number).padStart(4, "0");
    migrations[key] = row[`m${key}`] === true;
  }
  return {
    migrations,
    missing: Object.keys(migrations)
      .filter((key) => !migrations[key])
      .sort(),
    wukongAppRole: row.wukong_app_role === true,
    currentUser: String(row.current_user ?? ""),
    counts: {
      listing_drafts: Number(row.count_listing_drafts),
      listing_versions: Number(row.count_listing_versions),
      listing_pipeline_runs: Number(row.count_listing_pipeline_runs),
    },
    appGrants: Object.fromEntries(
      GRANT_TABLES.map((table) => [table, row[`grant_${table}`] === true]),
    ),
  };
}

/** Runs `work` in a transaction Postgres itself refuses to write in. */
export async function readOnly<T>(
  client: postgres.Sql,
  work: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return client.begin(async (transaction) => {
    await transaction.unsafe("SET TRANSACTION READ ONLY");
    return work(transaction);
  }) as Promise<T>;
}

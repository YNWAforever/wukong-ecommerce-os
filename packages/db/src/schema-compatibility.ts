export const SCHEMA_COMPATIBILITY_VERSION = "t01-0023-0027-v1";

export type SchemaCapabilityRow = {
  outbox_table: boolean;
  outbox_rls_enabled: boolean;
  outbox_rls_forced: boolean;
  outbox_workspace_policy: boolean;
  outbox_app_privileges: boolean;
  sweeper_function: boolean;
  sweeper_security_definer: boolean;
  sweeper_public_execute_revoked: boolean;
  sweeper_app_execute_granted: boolean;
  sweeper_orders_oldest_first: boolean;
  sweeper_bounds_attempts: boolean;
  export_source_attestation: boolean;
  export_attestation_nullable: boolean;
  export_attestation_no_default: boolean;
  export_attestation_array_check: boolean;
  import_guard_function: boolean;
  import_guard_accepts_legacy_attestation: boolean;
  import_guard_accepts_digest_attestation: boolean;
  import_guard_rejects_missing_attestation: boolean;
  import_guard_public_execute_revoked: boolean;
  import_guard_app_execute_granted: boolean;
  review_field_records: boolean;
  review_field_records_nullable: boolean;
  review_field_records_no_default: boolean;
  review_field_records_object_check: boolean;
};

export type SchemaCompatibilityReport = {
  version: typeof SCHEMA_COMPATIBILITY_VERSION;
  ready: boolean;
  missing: string[];
};

export type CatalogQuery = (
  sql: string,
) => Promise<readonly SchemaCapabilityRow[]>;

const capabilityGroups: Record<keyof SchemaCapabilityRow, string> = {
  outbox_table: "0023",
  outbox_rls_enabled: "0023",
  outbox_rls_forced: "0023",
  outbox_workspace_policy: "0023",
  outbox_app_privileges: "0023",
  sweeper_function: "0024",
  sweeper_security_definer: "0024",
  sweeper_public_execute_revoked: "0024",
  sweeper_app_execute_granted: "0024",
  sweeper_orders_oldest_first: "0024",
  sweeper_bounds_attempts: "0024",
  export_source_attestation: "0025",
  export_attestation_nullable: "0025",
  export_attestation_no_default: "0025",
  export_attestation_array_check: "0025",
  import_guard_function: "0026",
  import_guard_accepts_legacy_attestation: "0026",
  import_guard_accepts_digest_attestation: "0026",
  import_guard_rejects_missing_attestation: "0026",
  import_guard_public_execute_revoked: "0026",
  import_guard_app_execute_granted: "0026",
  review_field_records: "0027",
  review_field_records_nullable: "0027",
  review_field_records_no_default: "0027",
  review_field_records_object_check: "0027",
};

// Catalog-only and read-only. It checks behavior-bearing definitions as well as
// presence, because the production drift included an older function body.
export const SCHEMA_COMPATIBILITY_SQL = String.raw`
WITH funcs AS (
  SELECT
    coalesce(pg_get_functiondef(to_regprocedure('public.sweeper_find_undispatched_listing_jobs(integer,integer,integer)')), '') AS sweeper_def,
    coalesce(pg_get_functiondef(to_regprocedure('public.guard_import_result_insert()')), '') AS guard_def
), outbox AS (
  SELECT c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  WHERE c.oid = to_regclass('public.listing_dispatch_outbox')
), columns AS (
  SELECT table_name, column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (table_name, column_name) IN (
      ('export_attempts', 'source_attestation'),
      ('review_confirmations', 'field_records')
    )
)
SELECT
  to_regclass('public.listing_dispatch_outbox') IS NOT NULL AS outbox_table,
  coalesce((SELECT relrowsecurity FROM outbox), false) AS outbox_rls_enabled,
  coalesce((SELECT relforcerowsecurity FROM outbox), false) AS outbox_rls_forced,
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='listing_dispatch_outbox' AND policyname='listing_dispatch_outbox_workspace_policy' AND 'wukong_app'=ANY(roles) AND qual LIKE '%app.workspace_id%' AND with_check LIKE '%app.workspace_id%') AS outbox_workspace_policy,
  coalesce(has_table_privilege('wukong_app', to_regclass('public.listing_dispatch_outbox'), 'SELECT,INSERT,UPDATE,DELETE'), false) AS outbox_app_privileges,
  to_regprocedure('public.sweeper_find_undispatched_listing_jobs(integer,integer,integer)') IS NOT NULL AS sweeper_function,
  coalesce((SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.sweeper_find_undispatched_listing_jobs(integer,integer,integer)')), false) AS sweeper_security_definer,
  NOT coalesce(has_function_privilege('public', to_regprocedure('public.sweeper_find_undispatched_listing_jobs(integer,integer,integer)'), 'EXECUTE'), false) AS sweeper_public_execute_revoked,
  coalesce(has_function_privilege('wukong_app', to_regprocedure('public.sweeper_find_undispatched_listing_jobs(integer,integer,integer)'), 'EXECUTE'), false) AS sweeper_app_execute_granted,
  position('ORDER BY o.created_at, o.id' in (SELECT sweeper_def FROM funcs)) > 0 AS sweeper_orders_oldest_first,
  position('o.attempts < max_attempts' in (SELECT sweeper_def FROM funcs)) > 0 AS sweeper_bounds_attempts,
  EXISTS (SELECT 1 FROM columns WHERE table_name='export_attempts' AND column_name='source_attestation') AS export_source_attestation,
  EXISTS (SELECT 1 FROM columns WHERE table_name='export_attempts' AND column_name='source_attestation' AND is_nullable='YES') AS export_attestation_nullable,
  EXISTS (SELECT 1 FROM columns WHERE table_name='export_attempts' AND column_name='source_attestation' AND column_default IS NULL) AS export_attestation_no_default,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.export_attempts') AND conname='export_attempts_source_attestation_is_array' AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(source_attestation)%array%') AS export_attestation_array_check,
  to_regprocedure('public.guard_import_result_insert()') IS NOT NULL AS import_guard_function,
  position('freshnessAttested' in (SELECT guard_def FROM funcs)) > 0 AS import_guard_accepts_legacy_attestation,
  position('rowDigestMismatchCount' in (SELECT guard_def FROM funcs)) > 0 AS import_guard_accepts_digest_attestation,
  position('export_provenance_incomplete' in (SELECT guard_def FROM funcs)) > 0 AS import_guard_rejects_missing_attestation,
  NOT coalesce(has_function_privilege('public', to_regprocedure('public.guard_import_result_insert()'), 'EXECUTE'), false) AS import_guard_public_execute_revoked,
  coalesce(has_function_privilege('wukong_app', to_regprocedure('public.guard_import_result_insert()'), 'EXECUTE'), false) AS import_guard_app_execute_granted,
  EXISTS (SELECT 1 FROM columns WHERE table_name='review_confirmations' AND column_name='field_records') AS review_field_records,
  EXISTS (SELECT 1 FROM columns WHERE table_name='review_confirmations' AND column_name='field_records' AND is_nullable='YES') AS review_field_records_nullable,
  EXISTS (SELECT 1 FROM columns WHERE table_name='review_confirmations' AND column_name='field_records' AND column_default IS NULL) AS review_field_records_no_default,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.review_confirmations') AND conname='review_confirmations_field_records_is_object' AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(field_records)%object%') AS review_field_records_object_check
FROM funcs`;

export async function inspectSchemaCompatibility(
  query: CatalogQuery,
): Promise<SchemaCompatibilityReport> {
  const rows = await query(SCHEMA_COMPATIBILITY_SQL);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row) {
    return {
      version: SCHEMA_COMPATIBILITY_VERSION,
      ready: false,
      missing: ["catalog.unavailable"],
    };
  }
  const missing = (
    Object.keys(capabilityGroups) as Array<keyof SchemaCapabilityRow>
  )
    .filter((capability) => row[capability] !== true)
    .map((capability) => `${capabilityGroups[capability]}.${capability}`);
  return {
    version: SCHEMA_COMPATIBILITY_VERSION,
    ready: missing.length === 0,
    missing,
  };
}

export async function assertSchemaCompatibility(
  query: CatalogQuery,
): Promise<SchemaCompatibilityReport> {
  const report = await inspectSchemaCompatibility(query);
  if (!report.ready) {
    throw new Error(
      `Database setup is incomplete for this operation (${report.version})`,
    );
  }
  return report;
}

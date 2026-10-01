export const LISTING_READ_COMPATIBILITY_VERSION = "listing-read-0046-v1";
const capabilities = [
  "source_import_column",
  "source_digest_column",
  "source_binding_fk",
  "versions_rls",
  "app_can_read_versions",
  "runtime_role_safe",
  "effective_runtime_role",
] as const;

// Catalog-only: no tenant contents, provider request, write or migration.
export const LISTING_READ_COMPATIBILITY_SQL = `SELECT
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='listing_versions' AND column_name='source_import_id' AND data_type='uuid' AND is_nullable='YES' AND column_default IS NULL) AS source_import_column,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='listing_versions' AND column_name='source_row_digest' AND data_type='text' AND is_nullable='YES' AND column_default IS NULL) AS source_digest_column,
  EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.listing_versions') AND conname='listing_versions_workspace_source_import_fkey' AND contype='f' AND convalidated AND confrelid=to_regclass('public.source_imports') AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (workspace_id, source_import_id) REFERENCES source_imports(workspace_id, id)%') AS source_binding_fk,
  EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.listing_versions') AND relrowsecurity AND relforcerowsecurity) AS versions_rls,
  coalesce(has_table_privilege('wukong_app',to_regclass('public.listing_versions'),'SELECT'),false) AS app_can_read_versions,
  EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wukong_app' AND NOT rolsuper AND NOT rolbypassrls) AS runtime_role_safe,
  current_user='wukong_app' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND NOT rolsuper AND NOT rolbypassrls) AS effective_runtime_role`;

export async function inspectListingReadCompatibility(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
) {
  const rows = await query(LISTING_READ_COMPATIBILITY_SQL);
  const missing = capabilities
    .filter((name) => rows.length !== 1 || rows[0]?.[name] !== true)
    .map((name) => `0046.${name}`);
  return {
    version: LISTING_READ_COMPATIBILITY_VERSION,
    ready: missing.length === 0,
    missing,
  };
}

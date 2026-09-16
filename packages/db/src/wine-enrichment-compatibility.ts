const tables = [
  "wine_stages",
  "wine_evidence",
  "wine_section_snapshots",
  "wine_source_authorities",
  "wine_trusted_contexts",
  "search_budget_reservations",
  "wine_search_calls",
];
export async function inspectWineEnrichmentCompatibility(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
) {
  const rows =
    await query(`WITH required(name) AS (VALUES ${tables.map((t) => `('${t}')`).join(",")})
 SELECT name AS capability, EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=name AND c.relrowsecurity AND c.relforcerowsecurity AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND (has_table_privilege(current_user,c.oid,'UPDATE') = (name IN ('wine_stages','wine_search_calls','search_budget_reservations'))) AND NOT has_table_privilege(current_user,c.oid,'DELETE') AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='wine_workspace_policy') AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='wine_immutable_guard' AND t.tgenabled='O')) AS ready FROM required
 UNION ALL SELECT 'runtime_role',current_user='wukong_app' AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
 UNION ALL SELECT 'constraint.'||name,EXISTS(SELECT 1 FROM pg_constraint WHERE conname=name AND convalidated) FROM (VALUES ('wine_stages_run_fk'),('wine_evidence_run_fk'),('wine_sections_run_fk'),('wine_sections_version_fk'),('wine_context_run_fk'),('search_budget_run_fk'),('search_budget_units_check'),('wine_calls_reservation_fk'),('wine_calls_units_check'),('wine_calls_slot_max_check')) checks(name)
 UNION ALL SELECT 'column.'||tab||'.'||col,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=tab AND column_name=col) FROM (VALUES ('wine_stages','dependency_digest'),('wine_stages','output'),('wine_evidence','payload'),('wine_section_snapshots','payload'),('wine_source_authorities','reviewer_id'),('wine_trusted_contexts','input_digest'),('search_budget_reservations','reserved_credits'),('search_budget_reservations','settled_credits'),('wine_search_calls','maximum_credits'),('wine_search_calls','credits')) cols(tab,col)`);
  const missing = rows
    .filter((row) => row.ready !== true)
    .map((row) => String(row.capability));
  if (rows.length !== 28) missing.push("wine.catalog_incomplete");
  return {
    version: "wine-enrichment-0041-v1",
    ready: missing.length === 0,
    missing,
  };
}

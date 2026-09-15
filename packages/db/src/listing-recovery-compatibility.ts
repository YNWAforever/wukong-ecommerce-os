import {
  inspectSchemaCompatibility,
  type SchemaCapabilityRow,
} from "./schema-compatibility.js";
export async function inspectListingRecoveryCompatibility(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
) {
  const base = await inspectSchemaCompatibility(
    async (sql) => (await query(sql)) as SchemaCapabilityRow[],
  );
  const rows =
    await query(`WITH required_table(name) AS (VALUES ('listing_input_revisions'),('ai_budget_reservations'),('listing_create_requests'),('listing_enrichment_suggestions'),('listing_enrichment_decisions'),('listing_claim_supports'),('listing_version_claim_supports')),
required_column(tab,col) AS (VALUES ('listing_drafts','input_revision'),('listing_drafts','current_run_id'),('listing_pipeline_runs','input_revision'),('listing_pipeline_runs','base_version_id'),('listing_pipeline_runs','execution'),('listing_pipeline_runs','execution_state'),('listing_pipeline_runs','request_key'),('listing_pipeline_runs','request_digest'),('listing_pipeline_runs','run_attempt'),('ai_runs','pipeline_run_id'),('ai_runs','usage_certainty'),('listing_pipeline_runs','retry_of_run_id'),('enrichment_batches','control_revision'),('enrichment_batches','command_receipts'),('enrichment_batch_items','retry_of_item_id'),('enrichment_batch_items','is_current'))
SELECT 'table.'||name AS capability, EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=name AND c.relrowsecurity AND c.relforcerowsecurity AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid) AND has_table_privilege('wukong_app',c.oid,'SELECT')) AS ready FROM required_table
UNION ALL SELECT 'column.'||tab||'.'||col, EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=tab AND column_name=col) FROM required_column
UNION ALL SELECT 'recovery.function', EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='sweeper_find_abandoned_listing_operations' AND p.prosecdef AND has_function_privilege('wukong_app',p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))
UNION ALL SELECT 'guard.'||name, EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgname=name AND NOT t.tgisinternal AND t.tgenabled='O') FROM (VALUES ('listing_operation_identity_guard'),('listing_generated_version_guard'),('listing_terminal_steps_guard')) guards(name)`);
  const missing = [
    ...base.missing,
    ...rows.filter((r) => r.ready !== true).map((r) => String(r.capability)),
  ];
  if (rows.length !== 27) missing.push("recovery.catalog_incomplete");
  return {
    version: "listing-recovery-0040-v1",
    ready: missing.length === 0,
    missing,
  };
}

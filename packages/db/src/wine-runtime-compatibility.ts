const expectedOutboxBody =
  " SELECT o.workspace_id,o.id AS outbox_id,o.payload FROM public.listing_dispatch_outbox o\n WHERE o.dispatched_at IS NULL\n   AND o.created_at < now()-make_interval(secs=>older_than_seconds)\n   AND o.attempts < max_attempts\n   AND (o.payload->>'flowVersion' IS DISTINCT FROM 'wine-enrichment-v1' OR EXISTS(\n     SELECT 1 FROM public.listing_pipeline_runs r\n     WHERE r.workspace_id=o.workspace_id AND r.id::text=o.payload->>'runId'\n       AND o.payload->>'workspaceId'=o.workspace_id AND o.payload->'schemaVersion'='2'::jsonb\n       AND r.execution->>'flowVersion'='wine-enrichment-v1' AND r.execution_state IN ('queued','running')\n       AND r.listing_id::text=o.payload->>'draftId'\n       AND r.input_revision::text=o.payload->>'inputRevision'\n       AND r.active_version_sequence::text=o.payload->>'activeVersionSequence'\n       AND o.payload->>'stage' IN ('extraction','search_basic','verification','search_deep','verification_deep','generation','quality_check','commit_candidate')\n       AND o.dedupe_key='wine-run:'||r.id::text||':'||(o.payload->>'stage')\n       AND NOT EXISTS(SELECT 1 FROM public.wine_stages s WHERE s.workspace_id=r.workspace_id AND s.run_id=r.id AND s.stage=o.payload->>'stage')\n   ))\n ORDER BY o.created_at, o.id LIMIT max_rows;";
const expectedWineBody =
  " SELECT r.workspace_id,r.id FROM public.listing_pipeline_runs r\n WHERE r.execution->>'flowVersion'='wine-enrichment-v1'\n   AND r.execution_state IN ('queued','running')\n   AND (r.created_at <= now()-interval '15 minutes'\n     OR EXISTS(SELECT 1 FROM public.listing_dispatch_outbox o\n       WHERE o.workspace_id=r.workspace_id AND o.payload->>'runId'=r.id::text\n         AND o.payload->>'flowVersion'='wine-enrichment-v1'\n         AND o.dedupe_key='wine-run:'||r.id::text||':'||(o.payload->>'stage')\n         AND o.payload->>'stage' IN ('extraction','search_basic','verification','search_deep','verification_deep','generation','quality_check','commit_candidate')\n         AND NOT EXISTS(SELECT 1 FROM public.wine_stages s WHERE s.workspace_id=r.workspace_id AND s.run_id=r.id AND s.stage=o.payload->>'stage')\n         AND o.dispatched_at IS NULL AND o.attempts>=greatest(max_attempts,5)))\n ORDER BY r.created_at,r.id LIMIT greatest(0,least(max_rows,20));";
const expectedLegacyBody =
  " SELECT r.workspace_id,r.id FROM public.listing_pipeline_runs r\n WHERE r.execution_state IN ('queued','running')\n   AND r.execution->>'flowVersion' IS DISTINCT FROM 'wine-enrichment-v1'\n   AND r.updated_at < now()-make_interval(secs=>greatest(older_than_seconds,900))\n   AND NOT EXISTS(SELECT 1 FROM public.listing_pipeline_steps p WHERE p.workspace_id=r.workspace_id AND p.pipeline_run_id=r.id AND p.state='running' AND p.updated_at >= now()-interval '360 seconds')\n   AND (r.execution_state='running' OR EXISTS(SELECT 1 FROM public.listing_dispatch_outbox o WHERE o.workspace_id=r.workspace_id AND o.dedupe_key=r.idempotency_key AND (o.attempts>=greatest(max_attempts,5) OR o.dispatched_at < now()-make_interval(secs=>greatest(older_than_seconds,900)))) OR NOT EXISTS(SELECT 1 FROM public.listing_dispatch_outbox o WHERE o.workspace_id=r.workspace_id AND o.dedupe_key=r.idempotency_key))\n ORDER BY r.updated_at,r.id LIMIT greatest(0,least(max_rows,20));";
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const normalized = (s: string) =>
  `regexp_replace(${s}, '[[:space:]]+', '', 'g')`;
/** Additive runtime readiness; does not rewrite accepted 0042 artifact capabilities. */
export async function inspectWineRuntimeCompatibility(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
) {
  const rows =
    await query(`SELECT 'wine.runtime_finder' capability, EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.sweeper_find_abandoned_wine_operations(integer,integer)') AND p.prosecdef AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname='wukong_app') AND p.proconfig=ARRAY['search_path=public'] AND has_function_privilege('wukong_app',p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AND ${normalized("p.prosrc")}=${normalized(literal(expectedWineBody))}) ready
 UNION ALL SELECT 'wine.legacy_exclusion',EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.sweeper_find_abandoned_listing_operations(integer,integer,integer)') AND ${normalized("p.prosrc")}=${normalized(literal(expectedLegacyBody))})
 UNION ALL SELECT 'wine.outbox_finder',EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.sweeper_find_undispatched_listing_jobs(integer,integer,integer)') AND p.prosecdef AND p.proconfig=ARRAY['search_path=public'] AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname='wukong_app') AND has_function_privilege('wukong_app',p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AND ${normalized("p.prosrc")}=${normalized(literal(expectedOutboxBody))})`);
  const missing = rows
    .filter((r) => r.ready !== true)
    .map((r) => String(r.capability));
  if (rows.length !== 3) missing.push("wine.runtime_catalog_incomplete");
  return {
    version: "wine-runtime-0043-v1",
    ready: missing.length === 0,
    missing,
  };
}

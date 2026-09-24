-- Wine uses immutable acceptance time, not a renewable execution lease.
CREATE OR REPLACE FUNCTION sweeper_find_abandoned_wine_operations(max_rows integer,max_attempts integer)
RETURNS TABLE(workspace_id text,run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
AS $$
 SELECT r.workspace_id,r.id FROM public.listing_pipeline_runs r
 WHERE r.execution->>'flowVersion'='wine-enrichment-v1'
   AND r.execution_state IN ('queued','running')
   AND (r.created_at <= now()-interval '15 minutes'
     OR EXISTS(SELECT 1 FROM public.listing_dispatch_outbox o
       WHERE o.workspace_id=r.workspace_id AND o.payload->>'runId'=r.id::text
         AND o.payload->>'flowVersion'='wine-enrichment-v1'
         AND o.dedupe_key='wine-run:'||r.id::text||':'||(o.payload->>'stage')
         AND o.payload->>'stage' IN ('extraction','search_basic','verification','search_deep','verification_deep','generation','quality_check','commit_candidate')
         AND NOT EXISTS(SELECT 1 FROM public.wine_stages s WHERE s.workspace_id=r.workspace_id AND s.run_id=r.id AND s.stage=o.payload->>'stage')
         AND o.dispatched_at IS NULL AND o.attempts>=greatest(max_attempts,5)))
 ORDER BY r.created_at,r.id LIMIT greatest(0,least(max_rows,20));
$$;
REVOKE ALL ON FUNCTION sweeper_find_abandoned_wine_operations(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_abandoned_wine_operations(integer,integer) TO wukong_app;
CREATE INDEX IF NOT EXISTS wine_operations_deadline_idx ON listing_pipeline_runs(created_at,id)
 WHERE execution->>'flowVersion'='wine-enrichment-v1' AND execution_state IN ('queued','running');

-- Bounded inspection only. Mutations and audit remain inside forWorkspace.
CREATE OR REPLACE FUNCTION sweeper_find_abandoned_listing_operations(older_than_seconds integer,max_rows integer,max_attempts integer)
RETURNS TABLE(workspace_id text,run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
AS $$
 SELECT r.workspace_id,r.id FROM public.listing_pipeline_runs r
 WHERE r.execution_state IN ('queued','running')
   AND r.execution->>'flowVersion' IS DISTINCT FROM 'wine-enrichment-v1'
   AND r.updated_at < now()-make_interval(secs=>greatest(older_than_seconds,900))
   AND NOT EXISTS(SELECT 1 FROM public.listing_pipeline_steps p WHERE p.workspace_id=r.workspace_id AND p.pipeline_run_id=r.id AND p.state='running' AND p.updated_at >= now()-interval '360 seconds')
   AND (r.execution_state='running' OR EXISTS(SELECT 1 FROM public.listing_dispatch_outbox o WHERE o.workspace_id=r.workspace_id AND o.dedupe_key=r.idempotency_key AND (o.attempts>=greatest(max_attempts,5) OR o.dispatched_at < now()-make_interval(secs=>greatest(older_than_seconds,900)))) OR NOT EXISTS(SELECT 1 FROM public.listing_dispatch_outbox o WHERE o.workspace_id=r.workspace_id AND o.dedupe_key=r.idempotency_key))
 ORDER BY r.updated_at,r.id LIMIT greatest(0,least(max_rows,20));
$$;
REVOKE ALL ON FUNCTION sweeper_find_abandoned_listing_operations(integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_abandoned_listing_operations(integer,integer,integer) TO wukong_app;
CREATE INDEX IF NOT EXISTS listing_operations_abandoned_idx ON listing_pipeline_runs(updated_at,id) WHERE execution_state IN ('queued','running');


-- Do not let old terminal/completed wine stage rows starve the bounded pending scan.
CREATE OR REPLACE FUNCTION sweeper_find_undispatched_listing_jobs(older_than_seconds integer,max_rows integer,max_attempts integer)
RETURNS TABLE(workspace_id text,outbox_id uuid,payload jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=public
AS $$
 SELECT o.workspace_id,o.id AS outbox_id,o.payload FROM public.listing_dispatch_outbox o
 WHERE o.dispatched_at IS NULL
   AND o.created_at < now()-make_interval(secs=>older_than_seconds)
   AND o.attempts < max_attempts
   AND (o.payload->>'flowVersion' IS DISTINCT FROM 'wine-enrichment-v1' OR EXISTS(
     SELECT 1 FROM public.listing_pipeline_runs r
     WHERE r.workspace_id=o.workspace_id AND r.id::text=o.payload->>'runId'
       AND o.payload->>'workspaceId'=o.workspace_id AND o.payload->'schemaVersion'='2'::jsonb
       AND r.execution->>'flowVersion'='wine-enrichment-v1' AND r.execution_state IN ('queued','running')
       AND r.listing_id::text=o.payload->>'draftId'
       AND r.input_revision::text=o.payload->>'inputRevision'
       AND r.active_version_sequence::text=o.payload->>'activeVersionSequence'
       AND o.payload->>'stage' IN ('extraction','search_basic','verification','search_deep','verification_deep','generation','quality_check','commit_candidate')
       AND o.dedupe_key='wine-run:'||r.id::text||':'||(o.payload->>'stage')
       AND NOT EXISTS(SELECT 1 FROM public.wine_stages s WHERE s.workspace_id=r.workspace_id AND s.run_id=r.id AND s.stage=o.payload->>'stage')
   ))
 ORDER BY o.created_at, o.id LIMIT max_rows;
$$;
REVOKE ALL ON FUNCTION sweeper_find_undispatched_listing_jobs(integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_undispatched_listing_jobs(integer,integer,integer) TO wukong_app;

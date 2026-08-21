-- Cross-workspace read for the Worker's cron sweeper. wukong_app cannot
-- enumerate tenants (FORCE RLS keyed on the app.workspace_id GUC), so this
-- follows the 0002_auth_access_rls.sql precedent: a SECURITY DEFINER function
-- owned by the migration role, EXECUTE granted to wukong_app only.
--
-- Two stuck shapes:
--   A) a draft whose creation-time enqueue push failed: status 'received',
--      has at least one attached source asset, and no pipeline run row exists
--      for its current active version sequence.
--   B) a pipeline run reopened (or crashed) with nothing in flight: run
--      'started' and stale, no step actively leased within the 300s lease
--      window, and the draft's current sequence still matches the run's.
CREATE OR REPLACE FUNCTION sweeper_find_stuck_listing_jobs(
  older_than_seconds integer,
  max_rows integer
)
RETURNS TABLE (
  workspace_id text,
  draft_id uuid,
  active_version_sequence integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $sweeper_find_stuck_listing_jobs$
  WITH draft_sequences AS (
    SELECT
      d.workspace_id,
      d.id AS draft_id,
      d.status,
      d.created_at,
      COALESCE(v.sequence, 0) AS active_version_sequence
    FROM public.listing_drafts d
    LEFT JOIN public.listing_versions v
      ON v.workspace_id = d.workspace_id
     AND v.id = d.active_version_id
  ),
  never_started AS (
    SELECT s.workspace_id, s.draft_id, s.active_version_sequence
    FROM draft_sequences s
    WHERE s.status = 'received'
      AND s.created_at < now() - make_interval(secs => older_than_seconds)
      AND EXISTS (
        SELECT 1 FROM public.source_assets a
        WHERE a.workspace_id = s.workspace_id
          AND a.listing_id = s.draft_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.listing_pipeline_runs r
        WHERE r.workspace_id = s.workspace_id
          AND r.listing_id = s.draft_id
          AND r.active_version_sequence = s.active_version_sequence
      )
  ),
  stalled_runs AS (
    SELECT s.workspace_id, s.draft_id, s.active_version_sequence
    FROM draft_sequences s
    JOIN public.listing_pipeline_runs r
      ON r.workspace_id = s.workspace_id
     AND r.listing_id = s.draft_id
     AND r.active_version_sequence = s.active_version_sequence
    WHERE r.status = 'started'
      AND r.updated_at < now() - make_interval(secs => older_than_seconds)
      AND s.status IN ('received', 'processing', 'needs_info', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM public.listing_pipeline_steps p
        WHERE p.workspace_id = r.workspace_id
          AND p.pipeline_run_id = r.id
          AND p.state = 'running'
          AND p.updated_at >= now() - interval '300 seconds'
      )
  )
  SELECT * FROM never_started
  UNION
  SELECT * FROM stalled_runs
  ORDER BY workspace_id, draft_id
  LIMIT max_rows;
$sweeper_find_stuck_listing_jobs$;

REVOKE ALL ON FUNCTION sweeper_find_stuck_listing_jobs(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_stuck_listing_jobs(integer, integer) TO wukong_app;

-- Partial indexes for the two CTEs above: "stuck" rows are a small minority
-- of each table, so these keep every 5-minute tick cheap regardless of total
-- table size, instead of a full sequential scan on tables with no
-- workspace_id predicate to use the existing tenant-leading indexes.
CREATE INDEX IF NOT EXISTS listing_drafts_sweeper_received_idx
  ON listing_drafts (created_at)
  WHERE status = 'received';

CREATE INDEX IF NOT EXISTS listing_pipeline_runs_sweeper_started_idx
  ON listing_pipeline_runs (updated_at)
  WHERE status = 'started';

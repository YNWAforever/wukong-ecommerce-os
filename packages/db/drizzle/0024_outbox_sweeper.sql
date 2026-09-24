-- Cross-workspace read of work that was recorded and never sent.
--
-- 0023 made the intent durable, but only `advanceBatch` ever reads it back --
-- and `advanceBatch` runs only when an operator presses Advance on that one
-- batch. A workspace whose batches have all reached `completed` or
-- `budget_exhausted`, or which nobody touches again, never re-reads its own
-- outbox, so a row stranded by a request that died stays owed for ever.
--
-- `sweeper_find_stuck_listing_jobs` cannot cover this. It looks for a draft
-- with a source asset and no run row; a draft enriched from an import has no
-- asset, and an outbox row exists precisely when no run row does. The two
-- functions answer different questions and both are needed.
--
-- Same shape as 0007: wukong_app cannot enumerate tenants (FORCE RLS keyed on
-- the app.workspace_id GUC), so this is SECURITY DEFINER, owned by the
-- migration role, with EXECUTE granted to wukong_app alone.
--
-- Strictly additive: one function and one index. Nothing is altered or dropped,
-- and re-running the file is a no-op.
CREATE OR REPLACE FUNCTION sweeper_find_undispatched_listing_jobs(
  older_than_seconds integer,
  max_rows integer,
  max_attempts integer
)
RETURNS TABLE (
  workspace_id text,
  outbox_id uuid,
  payload jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $sweeper_find_undispatched_listing_jobs$
  SELECT o.workspace_id, o.id AS outbox_id, o.payload
  FROM public.listing_dispatch_outbox o
  WHERE o.dispatched_at IS NULL
    -- The web app's own grace window is 60s. The caller's must be longer, or
    -- the cron re-sends messages an advance is still in the middle of sending.
    AND o.created_at < now() - make_interval(secs => older_than_seconds)
    -- A payload the queue will never accept would otherwise be retried every
    -- tick for the life of the system. The count is the only thing that
    -- separates "the queue was down" from "this will never go"; rows at the
    -- cap stay in the table, visible, rather than being deleted.
    AND o.attempts < max_attempts
  -- Oldest first: the work owed longest is sent first.
  ORDER BY o.created_at, o.id
  LIMIT max_rows;
$sweeper_find_undispatched_listing_jobs$;

REVOKE ALL ON FUNCTION sweeper_find_undispatched_listing_jobs(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_undispatched_listing_jobs(integer, integer, integer) TO wukong_app;

-- 0023's pending index leads with workspace_id, which a cross-workspace scan
-- has no predicate for. Undispatched rows are a small minority, so this keeps
-- every tick cheap however large the table grows.
CREATE INDEX IF NOT EXISTS listing_dispatch_outbox_sweeper_idx
  ON listing_dispatch_outbox (created_at)
  WHERE dispatched_at IS NULL;

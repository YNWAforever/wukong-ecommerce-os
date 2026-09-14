-- A durable record of work we intended to send.
--
-- Batch dispatch was an in-request loop that ran AFTER its claim transaction
-- committed. A request that died mid-wave left its items `queued` with no queue
-- message, no audit event, and nothing able to find them: the sweeper requires
-- a source asset, which imported drafts never have, and `claimWave` only claims
-- `pending`. The work was lost silently and permanently.
--
-- A recovery pass could not be written without this table, because nothing
-- recorded the INTENT to send. `listing_pipeline_runs` appears only once the
-- pipeline claims its first step, so "no run row" cannot distinguish "never
-- dispatched" from "dispatched and still sitting in the queue" -- and re-sending
-- the second case buys a duplicate extraction, which costs money.
--
-- Writing the row inside the claim transaction removes the ambiguity: it exists
-- before any send is attempted, and `dispatched_at` says which of the two
-- happened. Strictly additive; nothing existing is altered or dropped.
CREATE TABLE IF NOT EXISTS listing_dispatch_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  listing_id uuid NOT NULL,
  -- The queue run key this payload will be sent under. Unique per workspace, so
  -- the same job can never be written twice however many times a wave is
  -- retried; a genuinely new run carries a new attempt and so a new key.
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 512),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  -- Restrict, not cascade: this row is the evidence that work was owed to a
  -- draft, and deleting the draft must not erase the record of it.
  CONSTRAINT listing_dispatch_outbox_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS listing_dispatch_outbox_workspace_id_uq
  ON listing_dispatch_outbox (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS listing_dispatch_outbox_dedupe_uq
  ON listing_dispatch_outbox (workspace_id, dedupe_key);

-- Partial: undispatched rows are the small minority, and they are the only ones
-- a recovery pass ever reads.
CREATE INDEX IF NOT EXISTS listing_dispatch_outbox_pending_idx
  ON listing_dispatch_outbox (workspace_id, created_at)
  WHERE dispatched_at IS NULL;

CREATE INDEX IF NOT EXISTS listing_dispatch_outbox_workspace_listing_idx
  ON listing_dispatch_outbox (workspace_id, listing_id);

DO $outbox_rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['listing_dispatch_outbox']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tenant_table || '_workspace_policy', tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO wukong_app USING (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), ''''))) WITH CHECK (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), '''')))',
      tenant_table || '_workspace_policy',
      tenant_table
    );
  END LOOP;
END
$outbox_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE listing_dispatch_outbox
  TO wukong_app;

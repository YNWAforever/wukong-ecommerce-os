-- Bind each enrichment item to one immutable listing operation and its spend.
ALTER TABLE enrichment_batch_items ADD COLUMN IF NOT EXISTS pipeline_run_id uuid;
ALTER TABLE enrichment_batch_items ADD COLUMN IF NOT EXISTS input_revision integer;
ALTER TABLE enrichment_batch_items ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE enrichment_batch_items ADD COLUMN IF NOT EXISTS reserved_usd numeric(14,6);
ALTER TABLE enrichment_batch_items DROP CONSTRAINT IF EXISTS enrichment_batch_items_reserved_usd_check;
ALTER TABLE enrichment_batch_items ADD CONSTRAINT enrichment_batch_items_reserved_usd_check CHECK (reserved_usd IS NULL OR reserved_usd >= 0);
ALTER TABLE enrichment_batch_items
  DROP CONSTRAINT IF EXISTS enrichment_batch_items_run_shape_check;
ALTER TABLE enrichment_batch_items
  ADD CONSTRAINT enrichment_batch_items_run_shape_check CHECK (
    (pipeline_run_id IS NULL AND input_revision IS NULL) OR
    (pipeline_run_id IS NOT NULL AND input_revision IS NOT NULL AND input_revision > 0)
  );
ALTER TABLE enrichment_batch_items
  DROP CONSTRAINT IF EXISTS enrichment_batch_items_outcome_check;
ALTER TABLE enrichment_batch_items
  ADD CONSTRAINT enrichment_batch_items_outcome_check CHECK (
    outcome IS NULL OR outcome IN ('this_run_success','needs_input','failed','already_prepared','skipped','superseded','cancelled')
  );
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batch_items_workspace_run_uq
  ON enrichment_batch_items(workspace_id,pipeline_run_id)
  WHERE pipeline_run_id IS NOT NULL;
ALTER TABLE enrichment_batch_items
  DROP CONSTRAINT IF EXISTS enrichment_batch_items_workspace_run_fkey;
ALTER TABLE enrichment_batch_items
  ADD CONSTRAINT enrichment_batch_items_workspace_run_fkey
    FOREIGN KEY(workspace_id,pipeline_run_id)
    REFERENCES listing_pipeline_runs(workspace_id,id) ON DELETE RESTRICT;
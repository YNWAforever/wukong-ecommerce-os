-- Visibility metadata only. Workflow, run lineage and cost holds stay intact.
ALTER TABLE enrichment_batches ADD COLUMN IF NOT EXISTS archived_at timestamptz;

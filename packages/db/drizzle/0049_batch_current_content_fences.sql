-- Additive compatibility: older batches retain their existing exact-run binding.
ALTER TABLE enrichment_batch_items ADD COLUMN IF NOT EXISTS content_fence jsonb;
ALTER TABLE enrichment_batch_items DROP CONSTRAINT IF EXISTS enrichment_batch_items_content_fence_check;
ALTER TABLE enrichment_batch_items ADD CONSTRAINT enrichment_batch_items_content_fence_check
  CHECK (content_fence IS NULL OR jsonb_typeof(content_fence) = 'object');

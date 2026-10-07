-- Read-only: reports which migrations 0041-0053 are present. Changes nothing.
SELECT m AS migration, present FROM (VALUES
 ('0041', to_regclass('public.wine_stages') IS NOT NULL),
 ('0042', to_regclass('public.wine_evidence_cache') IS NOT NULL),
 ('0043', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sweeper_find_abandoned_wine_operations')),
 ('0044', to_regclass('public.wine_sections_run_idx') IS NOT NULL),
 ('0045', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_runs' AND column_name = 'estimated_cost_usd' AND is_nullable = 'YES')),
 ('0046', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listing_versions' AND column_name = 'source_import_id')),
 ('0047', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_complete_enrollment')),
 ('0048', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_get_active_membership')),
 ('0049', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'enrichment_batch_items' AND column_name = 'content_fence')),
 ('0050', to_regclass('public.enrichment_batch_previews') IS NOT NULL),
 ('0051', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'enrichment_batches' AND column_name = 'archived_at')),
 ('0052', to_regclass('public.listing_assignments') IS NOT NULL),
 ('0053', to_regclass('public.listing_quality_assessments') IS NOT NULL)
) AS v(m, present) ORDER BY m;

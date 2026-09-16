-- Index tenant child references used by recovery, retry and evidence lineage.
CREATE INDEX IF NOT EXISTS enrichment_item_retry_parent ON enrichment_batch_items(workspace_id,retry_of_item_id);
CREATE INDEX IF NOT EXISTS claim_support_input ON listing_claim_supports(workspace_id,listing_id,input_revision);
CREATE INDEX IF NOT EXISTS claim_support_suggestion ON listing_claim_supports(workspace_id,listing_id,suggestion_id);
CREATE INDEX IF NOT EXISTS claim_support_base ON listing_claim_supports(workspace_id,listing_id,base_version_id);
CREATE INDEX IF NOT EXISTS create_request_listing ON listing_create_requests(workspace_id,listing_id);
CREATE INDEX IF NOT EXISTS listing_current_operation ON listing_drafts(workspace_id,current_run_id);
CREATE INDEX IF NOT EXISTS enrichment_decision_input ON listing_enrichment_decisions(workspace_id,listing_id,input_revision);
CREATE INDEX IF NOT EXISTS enrichment_decision_suggestion ON listing_enrichment_decisions(workspace_id,listing_id,suggestion_id);
CREATE INDEX IF NOT EXISTS enrichment_decision_base ON listing_enrichment_decisions(workspace_id,listing_id,base_version_id);
CREATE INDEX IF NOT EXISTS enrichment_suggestion_input ON listing_enrichment_suggestions(workspace_id,listing_id,input_revision);
CREATE INDEX IF NOT EXISTS enrichment_suggestion_base ON listing_enrichment_suggestions(workspace_id,listing_id,base_version_id);
CREATE INDEX IF NOT EXISTS input_revision_base ON listing_input_revisions(workspace_id,listing_id,base_version_id);
CREATE INDEX IF NOT EXISTS operation_retry_parent ON listing_pipeline_runs(workspace_id,retry_of_run_id);
CREATE INDEX IF NOT EXISTS operation_base ON listing_pipeline_runs(workspace_id,base_version_id);

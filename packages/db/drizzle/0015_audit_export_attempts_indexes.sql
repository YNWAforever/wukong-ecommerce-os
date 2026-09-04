-- Covers findRelatedToListing (packages/db/src/repositories/audit.ts) and
-- audit-verify.ts's release-gate query -- both filter workspace_id+entity_id
-- and sort by created_at, id. Neither is covered by the existing
-- audit_events_workspace_created_idx (workspace_id, created_at) alone.
CREATE INDEX IF NOT EXISTS audit_events_workspace_entity_idx
  ON audit_events (workspace_id, entity_id, created_at, id);

-- Covers countByActionSince, countByActionAndMetadataKeySince, and
-- sumImportMetricsSince (all three filter workspace_id+action+created_at>=).
CREATE INDEX IF NOT EXISTS audit_events_workspace_action_idx
  ON audit_events (workspace_id, action, created_at);

-- Covers listForWorkspace (packages/db/src/repositories/export-attempts.ts)
-- -- filters workspace_id, sorts by created_at desc, id desc. No index
-- covers this at all today; the only existing index is on
-- (workspace_id, idempotency_key).
CREATE INDEX IF NOT EXISTS export_attempts_workspace_created_idx
  ON export_attempts (workspace_id, created_at, id);

-- Covers listContainingListing's `manifest @> '[{"listingId":...}]'::jsonb`
-- containment check -- today a full per-workspace sequential scan comparing
-- every row's manifest. jsonb_path_ops (not the default jsonb_ops) is
-- correct here: smaller and faster specifically for @> containment, and
-- nothing in this codebase needs jsonb_ops' extra key-existence operators
-- (?, ?|, ?&) on this column.
CREATE INDEX IF NOT EXISTS export_attempts_manifest_gin_idx
  ON export_attempts USING GIN (manifest jsonb_path_ops);

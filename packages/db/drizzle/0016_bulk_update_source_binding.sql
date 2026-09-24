CREATE UNIQUE INDEX IF NOT EXISTS listing_versions_workspace_listing_id_uq ON listing_versions(workspace_id, listing_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS source_imports_workspace_connection_id_uq ON source_imports(workspace_id, connection_id, id);

CREATE TABLE IF NOT EXISTS source_row_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 listing_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 source_import_id uuid NOT NULL,
 remote_product_id text NOT NULL CHECK (length(remote_product_id) > 0),
 source_row_digest text NOT NULL CHECK (source_row_digest ~ '^[0-9a-f]{64}$'),
 raw_row jsonb NOT NULL CHECK (jsonb_typeof(raw_row) = 'object'),
 spec_version text NOT NULL,
 header_contract_sha256 text NOT NULL CHECK (header_contract_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT source_row_snapshots_listing_fkey FOREIGN KEY(workspace_id, listing_id) REFERENCES listing_drafts(workspace_id,id) ON DELETE RESTRICT,
 CONSTRAINT source_row_snapshots_import_fkey FOREIGN KEY(workspace_id, connection_id, source_import_id) REFERENCES source_imports(workspace_id,connection_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS source_row_snapshots_product_uq ON source_row_snapshots(workspace_id,source_import_id,connection_id,remote_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS source_row_snapshots_listing_id_uq ON source_row_snapshots(workspace_id,listing_id,id);
CREATE INDEX IF NOT EXISTS source_row_snapshots_import_idx ON source_row_snapshots(workspace_id,connection_id,source_import_id);

CREATE TABLE IF NOT EXISTS bulk_update_approval_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 listing_id uuid NOT NULL,
 version_id uuid NOT NULL,
 source_snapshot_id uuid NOT NULL,
 confirmation_version_id uuid NOT NULL,
 confirmation_revision integer NOT NULL CHECK (confirmation_revision >= 0),
 approved_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT bulk_update_approval_receipts_version_fkey FOREIGN KEY(workspace_id,listing_id,version_id) REFERENCES listing_versions(workspace_id,listing_id,id) ON DELETE RESTRICT,
 CONSTRAINT bulk_update_approval_receipts_confirmation_version_fkey FOREIGN KEY(workspace_id,listing_id,confirmation_version_id) REFERENCES listing_versions(workspace_id,listing_id,id) ON DELETE RESTRICT,
 CONSTRAINT bulk_update_approval_receipts_snapshot_fkey FOREIGN KEY(workspace_id,listing_id,source_snapshot_id) REFERENCES source_row_snapshots(workspace_id,listing_id,id) ON DELETE RESTRICT
);
-- Identity order is independent of transaction-start timestamps. Review locks
-- serialize receipt creation; sequence gaps from retries are intentionally safe.
ALTER TABLE bulk_update_approval_receipts ADD COLUMN IF NOT EXISTS receipt_ordinal bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS bulk_update_approval_receipts_ordinal_uq ON bulk_update_approval_receipts(receipt_ordinal);
GRANT USAGE ON SEQUENCE bulk_update_approval_receipts_receipt_ordinal_seq TO wukong_app;
CREATE UNIQUE INDEX IF NOT EXISTS bulk_update_approval_receipts_binding_uq ON bulk_update_approval_receipts(workspace_id,version_id,source_snapshot_id,confirmation_version_id,confirmation_revision);
CREATE INDEX IF NOT EXISTS bulk_update_approval_receipts_version_idx ON bulk_update_approval_receipts(workspace_id,listing_id,version_id);
CREATE INDEX IF NOT EXISTS bulk_update_approval_receipts_confirmation_idx ON bulk_update_approval_receipts(workspace_id,listing_id,confirmation_version_id);
CREATE INDEX IF NOT EXISTS bulk_update_approval_receipts_snapshot_idx ON bulk_update_approval_receipts(workspace_id,listing_id,source_snapshot_id);

DO $rls$
DECLARE tenant_table text;
BEGIN
 FOREACH tenant_table IN ARRAY ARRAY['source_row_snapshots','bulk_update_approval_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tenant_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tenant_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',tenant_table || '_workspace_policy',tenant_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO wukong_app USING (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), ''''))) WITH CHECK (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), '''')))',tenant_table || '_workspace_policy',tenant_table);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',tenant_table);
  EXECUTE format('REVOKE UPDATE, DELETE ON TABLE %I FROM wukong_app',tenant_table);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO wukong_app',tenant_table);
 END LOOP;
END $rls$;

-- Nullable expansion: old approvals remain untrusted; old export rows remain historical.
ALTER TABLE export_attempts ADD COLUMN IF NOT EXISTS provenance jsonb;
ALTER TABLE export_attempts ADD COLUMN IF NOT EXISTS artifact_sha256 text;
ALTER TABLE export_attempts ADD COLUMN IF NOT EXISTS artifact_status text;
ALTER TABLE export_attempts ADD COLUMN IF NOT EXISTS artifact_error_code text;
ALTER TABLE export_attempts ADD COLUMN IF NOT EXISTS artifact_ready_at timestamptz;
DO $checks$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='export_attempts'::regclass AND conname='export_attempts_artifact_status_check') THEN
 ALTER TABLE export_attempts ADD CONSTRAINT export_attempts_artifact_status_check CHECK (artifact_status IN ('pending','ready','failed'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='export_attempts'::regclass AND conname='export_attempts_artifact_hash_check') THEN
 ALTER TABLE export_attempts ADD CONSTRAINT export_attempts_artifact_hash_check CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$');
 END IF;
END $checks$;

-- All relevant writers acquire the same draft lock as approval/export. Invoker
-- security and explicit workspace predicates retain tenant RLS boundaries.
CREATE OR REPLACE FUNCTION lock_bulk_update_review_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $lock$
DECLARE old_listing uuid; new_listing uuid; old_workspace text; new_workspace text;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  old_workspace := OLD.workspace_id;
  IF TG_TABLE_NAME = 'compliance_flags' THEN
   SELECT listing_id INTO old_listing FROM listing_versions WHERE workspace_id=OLD.workspace_id AND id=OLD.listing_version_id;
  ELSE old_listing := OLD.listing_id;
  END IF;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  new_workspace := NEW.workspace_id;
  IF TG_TABLE_NAME = 'compliance_flags' THEN
   SELECT listing_id INTO new_listing FROM listing_versions WHERE workspace_id=NEW.workspace_id AND id=NEW.listing_version_id;
  ELSE new_listing := NEW.listing_id;
  END IF;
 END IF;
 PERFORM id FROM listing_drafts WHERE (workspace_id=old_workspace AND id=old_listing) OR (workspace_id=new_workspace AND id=new_listing) ORDER BY workspace_id,id FOR UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $lock$;
REVOKE ALL ON FUNCTION lock_bulk_update_review_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_bulk_update_review_state() TO wukong_app;
DROP TRIGGER IF EXISTS compliance_flags_review_lock ON compliance_flags;
CREATE TRIGGER compliance_flags_review_lock BEFORE INSERT OR UPDATE OR DELETE ON compliance_flags FOR EACH ROW EXECUTE FUNCTION lock_bulk_update_review_state();
DROP TRIGGER IF EXISTS review_confirmations_review_lock ON review_confirmations;
CREATE TRIGGER review_confirmations_review_lock BEFORE INSERT OR UPDATE OR DELETE ON review_confirmations FOR EACH ROW EXECUTE FUNCTION lock_bulk_update_review_state();
DROP TRIGGER IF EXISTS platform_products_review_lock ON platform_products;
CREATE TRIGGER platform_products_review_lock BEFORE INSERT OR UPDATE OR DELETE ON platform_products FOR EACH ROW EXECUTE FUNCTION lock_bulk_update_review_state();

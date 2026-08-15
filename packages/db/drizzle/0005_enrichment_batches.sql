DO $enrichment_enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enrichment_batch_status') THEN
    CREATE TYPE enrichment_batch_status AS ENUM ('open', 'running', 'completed', 'budget_exhausted', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enrichment_batch_item_status') THEN
    CREATE TYPE enrichment_batch_item_status AS ENUM ('pending', 'queued', 'succeeded', 'failed', 'skipped');
  END IF;
END
$enrichment_enums$;

CREATE TABLE IF NOT EXISTS enrichment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL,
  budget_usd numeric(12, 6) NOT NULL,
  wave_size integer NOT NULL,
  status enrichment_batch_status NOT NULL DEFAULT 'open',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batches_workspace_id_uq
  ON enrichment_batches (workspace_id, id);
CREATE INDEX IF NOT EXISTS enrichment_batches_workspace_status_idx
  ON enrichment_batches (workspace_id, status);

CREATE TABLE IF NOT EXISTS enrichment_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  status enrichment_batch_item_status NOT NULL DEFAULT 'pending',
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrichment_batch_items_workspace_batch_fkey
    FOREIGN KEY (workspace_id, batch_id)
    REFERENCES enrichment_batches (workspace_id, id)
    ON DELETE CASCADE,
  -- Restrict, not cascade: an item records money spent on a draft, and a draft
  -- delete must not erase that record.
  CONSTRAINT enrichment_batch_items_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batch_items_workspace_id_uq
  ON enrichment_batch_items (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batch_items_batch_listing_uq
  ON enrichment_batch_items (workspace_id, batch_id, listing_id);
CREATE INDEX IF NOT EXISTS enrichment_batch_items_workspace_batch_status_idx
  ON enrichment_batch_items (workspace_id, batch_id, status);
CREATE INDEX IF NOT EXISTS enrichment_batch_items_workspace_listing_idx
  ON enrichment_batch_items (workspace_id, listing_id);

DO $enrichment_rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['enrichment_batches', 'enrichment_batch_items']
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
$enrichment_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE enrichment_batches, enrichment_batch_items
  TO wukong_app;

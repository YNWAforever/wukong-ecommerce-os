CREATE TABLE IF NOT EXISTS platform_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  remote_product_id text NOT NULL,
  sku text NOT NULL,
  listing_id uuid,
  spec_version text NOT NULL,
  raw_row jsonb NOT NULL,
  facts_prefill jsonb NOT NULL,
  content_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_products_workspace_connection_fkey
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES shopline_connections (workspace_id, id)
    ON DELETE CASCADE,
  -- Restrict, not cascade: this row mirrors a product that exists on the
  -- platform whether or not Wukong keeps a draft, and its digest is the only
  -- thing that tells an unchanged re-import from a real catalog change.
  CONSTRAINT platform_products_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_products_workspace_id_uq
  ON platform_products (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS platform_products_workspace_connection_remote_uq
  ON platform_products (workspace_id, connection_id, remote_product_id);
CREATE INDEX IF NOT EXISTS platform_products_workspace_listing_idx
  ON platform_products (workspace_id, listing_id);

ALTER TABLE platform_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_products FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_products_workspace_policy ON platform_products;
CREATE POLICY platform_products_workspace_policy ON platform_products
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform_products TO wukong_app;

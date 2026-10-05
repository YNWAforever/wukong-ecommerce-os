ALTER TABLE enrichment_batches ADD COLUMN IF NOT EXISTS content_fields jsonb;
ALTER TABLE enrichment_batches DROP CONSTRAINT IF EXISTS enrichment_batches_content_fields_check;
ALTER TABLE enrichment_batches ADD CONSTRAINT enrichment_batches_content_fields_check CHECK (
 content_fields IS NULL OR (jsonb_typeof(content_fields)='array' AND jsonb_array_length(content_fields) BETWEEN 1 AND 8
 AND content_fields <@ '["nameZh","summaryEn","summaryZh","seoTitleEn","seoTitleZh","seoDescriptionEn","seoDescriptionZh","seoKeywords"]'::jsonb));

CREATE TABLE IF NOT EXISTS enrichment_batch_previews (
 workspace_id text NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 actor_id text NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL, options jsonb NOT NULL CHECK(jsonb_typeof(options)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS enrichment_batch_create_receipts (
 workspace_id text NOT NULL REFERENCES workspaces(id), request_key uuid NOT NULL,
 preview_id uuid NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 batch_id uuid NOT NULL, response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,request_key), UNIQUE(workspace_id,preview_id),
 FOREIGN KEY(workspace_id,preview_id) REFERENCES enrichment_batch_previews(workspace_id,id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES enrichment_batches(workspace_id,id)
);
ALTER TABLE enrichment_batch_previews ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS enrichment_batch_create_receipts_batch_idx ON enrichment_batch_create_receipts(workspace_id,batch_id);
ALTER TABLE enrichment_batch_previews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrichment_batch_previews_workspace_policy ON enrichment_batch_previews;
CREATE POLICY enrichment_batch_previews_workspace_policy ON enrichment_batch_previews FOR ALL TO wukong_app
 USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
ALTER TABLE enrichment_batch_create_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_batch_create_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enrichment_batch_create_receipts_workspace_policy ON enrichment_batch_create_receipts;
CREATE POLICY enrichment_batch_create_receipts_workspace_policy ON enrichment_batch_create_receipts FOR ALL TO wukong_app
 USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT ON enrichment_batch_previews,enrichment_batch_create_receipts TO wukong_app;
REVOKE UPDATE,DELETE ON enrichment_batch_previews,enrichment_batch_create_receipts FROM wukong_app;

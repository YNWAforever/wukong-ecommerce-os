CREATE TABLE IF NOT EXISTS workbook_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 workbook_sha256 text NOT NULL CHECK(workbook_sha256 ~ '^[0-9a-f]{64}$'),
 filename text NOT NULL CHECK(length(filename) BETWEEN 6 AND 255 AND lower(right(filename,5))='.xlsx'),
 sheet_name text NOT NULL CHECK(length(sheet_name) BETWEEN 1 AND 255),
 header_contract_sha256 text NOT NULL CHECK(header_contract_sha256 ~ '^[0-9a-f]{64}$'),
 normalized_sheet jsonb NOT NULL CHECK(jsonb_typeof(normalized_sheet)='array' AND octet_length(normalized_sheet::text)<=16777216),
 product_bindings jsonb NOT NULL CONSTRAINT workbook_imports_check CHECK(jsonb_typeof(product_bindings)='object' AND octet_length(normalized_sheet::text)+octet_length(product_bindings::text)<=16777216),
 spec_version text NOT NULL,
 inferred_export_time jsonb,
 total_rows integer NOT NULL CHECK(total_rows BETWEEN 1 AND 5000),
 eligible_products integer NOT NULL CHECK(eligible_products BETWEEN 1 AND 5000),
 excluded_rows integer NOT NULL CHECK(excluded_rows>=0 AND eligible_products+excluded_rows=total_rows),
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,workbook_sha256)
);
CREATE TABLE IF NOT EXISTS workbook_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 import_id uuid NOT NULL, row_number integer NOT NULL CHECK(row_number>0),
 product jsonb NOT NULL CONSTRAINT workbook_products_check CHECK(jsonb_typeof(product)='object' AND octet_length(product::text)<=1048576 AND COALESCE(jsonb_typeof(product->'rowNumber')='number' AND (product->>'rowNumber')::integer=row_number,false)),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,import_id) REFERENCES workbook_imports(workspace_id,id) ON DELETE RESTRICT,
 UNIQUE(workspace_id,import_id,row_number)
);
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workbook_imports','workbook_products'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS workbook_workspace ON %I',t);
  EXECUTE format('CREATE POLICY workbook_workspace ON %I FOR ALL TO wukong_app USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO wukong_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM wukong_app',t);
 END LOOP;
END $rls$;
CREATE OR REPLACE FUNCTION guard_workbook_catalog_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
BEGIN RAISE EXCEPTION 'workbook evidence is immutable'; END $guard$;
REVOKE ALL ON FUNCTION guard_workbook_catalog_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_workbook_catalog_mutation() TO wukong_app;
DO $triggers$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workbook_imports','workbook_products'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS workbook_immutable ON %I',t);
  EXECUTE format('CREATE TRIGGER workbook_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_workbook_catalog_mutation()',t);
 END LOOP;
END $triggers$;


CREATE OR REPLACE FUNCTION guard_workbook_product_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE expected_digest text;
BEGIN
 SELECT product_bindings->>NEW.row_number::text INTO expected_digest
 FROM workbook_imports WHERE workspace_id=NEW.workspace_id AND id=NEW.import_id;
 IF expected_digest IS NULL OR expected_digest<>encode(sha256(convert_to(NEW.product::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'workbook product requires immutable source binding'; END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_workbook_product_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_workbook_product_insert() TO wukong_app;
DROP TRIGGER IF EXISTS workbook_products_insert_guard ON workbook_products;
CREATE TRIGGER workbook_products_insert_guard BEFORE INSERT ON workbook_products FOR EACH ROW EXECUTE FUNCTION guard_workbook_product_insert();

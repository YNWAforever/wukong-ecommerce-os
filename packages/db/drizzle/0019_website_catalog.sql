CREATE TABLE IF NOT EXISTS website_scans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 requested_url text NOT NULL, requested_by text NOT NULL, request_key text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','ready','partial','failed')),
 checkpoint jsonb NOT NULL CHECK(jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=1048576),
 revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 32), attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 discovery_requests integer NOT NULL DEFAULT 0 CHECK(discovery_requests BETWEEN 0 AND 5), product_requests integer NOT NULL DEFAULT 0 CHECK(product_requests BETWEEN 0 AND 20), robots_requests integer NOT NULL DEFAULT 0 CHECK(robots_requests BETWEEN 0 AND 6),
 lease_token uuid, lease_expires_at timestamptz, next_eligible_at timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
 dispatch_status text NOT NULL DEFAULT 'pending' CHECK(dispatch_status IN ('pending','sent','failed')), dispatch_attempts integer NOT NULL DEFAULT 0 CHECK(dispatch_attempts>=0), dispatch_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,request_key)
);
CREATE TABLE IF NOT EXISTS website_scan_steps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 scan_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>=0), lease_token uuid NOT NULL,
 request_state text NOT NULL CHECK(request_state IN ('idle','fetching','completed')), result jsonb CHECK(result IS NULL OR octet_length(result::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,scan_id) REFERENCES website_scans(workspace_id,id), UNIQUE(workspace_id,scan_id,revision)
);
CREATE TABLE IF NOT EXISTS website_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 canonical_source_url text NOT NULL, source_scan_id uuid NOT NULL, source_key text NOT NULL,
 observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object' AND octet_length(observation::text)<=1048576),
 saved_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,canonical_source_url), FOREIGN KEY(workspace_id,source_scan_id) REFERENCES website_scans(workspace_id,id),
 CHECK(source_key=canonical_source_url AND observation->>'key'=source_key AND observation->>'sourceUrl'=canonical_source_url)
);
CREATE INDEX IF NOT EXISTS website_scans_recovery_idx ON website_scans(state,next_eligible_at,lease_expires_at);
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['website_scans','website_scan_steps','website_products'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS website_workspace ON %I',t);
  EXECUTE format('CREATE POLICY website_workspace ON %I FOR ALL TO wukong_app USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO wukong_app',t);
  EXECUTE format('REVOKE DELETE,TRUNCATE ON %I FROM wukong_app',t);
 END LOOP;
END $rls$;
GRANT UPDATE ON website_scans,website_scan_steps TO wukong_app;
REVOKE UPDATE ON website_products FROM wukong_app;
CREATE OR REPLACE FUNCTION guard_website_catalog_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
BEGIN
 IF TG_TABLE_NAME='website_products' THEN RAISE EXCEPTION 'website evidence is immutable'; END IF;
 IF TG_TABLE_NAME='website_scans' THEN
  IF OLD.state IN ('ready','partial','failed') THEN RAISE EXCEPTION 'website evidence is immutable'; END IF;
 ELSE
  IF OLD.request_state='completed' THEN RAISE EXCEPTION 'website evidence is immutable'; END IF;
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_website_catalog_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_website_catalog_mutation() TO wukong_app;
DO $triggers$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['website_scans','website_scan_steps','website_products'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS website_immutable ON %I',t);
  EXECUTE format('CREATE TRIGGER website_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_website_catalog_mutation()',t);
 END LOOP;
END $triggers$;
CREATE OR REPLACE FUNCTION sweeper_find_website_scans(max_rows integer)
RETURNS TABLE(workspace_id text,scan_id uuid,revision integer)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $sweep$
 SELECT s.workspace_id,s.id,s.revision FROM website_scans s WHERE s.state IN ('queued','running') AND (s.deadline_at<=now() OR (s.next_eligible_at<=now() AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=now()) AND (s.dispatch_at IS NULL OR s.dispatch_at<=now()-interval '60 seconds'))) ORDER BY least(s.next_eligible_at,s.deadline_at),s.id LIMIT greatest(1,least(max_rows,10));
$sweep$;
REVOKE ALL ON FUNCTION sweeper_find_website_scans(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_website_scans(integer) TO wukong_app;


CREATE OR REPLACE FUNCTION guard_website_product_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE scan website_scans%ROWTYPE;
BEGIN
 SELECT * INTO scan FROM website_scans WHERE workspace_id=NEW.workspace_id AND id=NEW.source_scan_id FOR SHARE;
 IF scan.id IS NULL OR scan.state NOT IN ('ready','partial') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(scan.checkpoint->'preview'->'products') p WHERE p->>'key'=NEW.source_key AND p=NEW.observation) THEN RAISE EXCEPTION 'website product requires immutable preview observation'; END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_website_product_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_website_product_insert() TO wukong_app;
DROP TRIGGER IF EXISTS website_products_insert_guard ON website_products;
CREATE TRIGGER website_products_insert_guard BEFORE INSERT ON website_products FOR EACH ROW EXECUTE FUNCTION guard_website_product_insert();

CREATE INDEX IF NOT EXISTS website_products_scan_idx ON website_products(workspace_id,source_scan_id);

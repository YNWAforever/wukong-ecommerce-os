-- Durable single-source attempts. Existing source uploads remain private.
CREATE UNIQUE INDEX IF NOT EXISTS source_assets_workspace_listing_id_uq ON source_assets(workspace_id,listing_id,id);

CREATE TABLE IF NOT EXISTS product_shot_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 listing_id uuid NOT NULL,
 source_asset_id uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 provider_version text NOT NULL CHECK(length(provider_version) BETWEEN 1 AND 100),
 render_version text NOT NULL CHECK(length(render_version) BETWEEN 1 AND 100),
 generation integer NOT NULL CHECK(generation>0),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','cutout_ready','candidate_ready','approved','failed','outcome_unknown')),
 lease_token uuid, lease_expires_at timestamptz, dispatched_at timestamptz,
 call_count integer NOT NULL DEFAULT 0 CHECK(call_count IN (0,1)),
 estimated_cost_usd numeric(14,6),
 cutout_asset_id uuid, cutout_digest text CHECK(cutout_digest ~ '^[0-9a-f]{64}$'),
 candidate_asset_id uuid, candidate_digest text CHECK(candidate_digest ~ '^[0-9a-f]{64}$'),
 candidate_width integer, candidate_height integer, candidate_size integer, candidate_low_resolution boolean,
 error_code text CHECK(error_code IN ('rejected','rate_limited','invalid_output','outcome_unknown','processing_failed','lease_expired')),
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,listing_id) REFERENCES listing_drafts(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,source_asset_id) REFERENCES source_assets(workspace_id,listing_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,cutout_asset_id) REFERENCES source_assets(workspace_id,listing_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,candidate_asset_id) REFERENCES source_assets(workspace_id,listing_id,id) ON DELETE RESTRICT,
 UNIQUE(workspace_id,listing_id,id),
 UNIQUE(workspace_id,listing_id,source_asset_id,source_digest,provider_version,render_version,generation),
 CHECK((dispatched_at IS NULL AND call_count=0) OR (dispatched_at IS NOT NULL AND call_count=1)),
 CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
 CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK(state<>'processing' OR (lease_token IS NOT NULL AND dispatched_at IS NOT NULL)),
 CHECK((cutout_asset_id IS NULL)=(cutout_digest IS NULL)),
 CHECK(state NOT IN ('cutout_ready','candidate_ready','approved') OR cutout_asset_id IS NOT NULL),
 CONSTRAINT product_shot_attempts_candidate_complete CHECK((candidate_asset_id IS NULL AND candidate_digest IS NULL AND candidate_width IS NULL AND candidate_height IS NULL AND candidate_size IS NULL AND candidate_low_resolution IS NULL)
   OR (candidate_asset_id IS NOT NULL AND candidate_digest IS NOT NULL AND candidate_width IS NOT NULL AND candidate_height IS NOT NULL AND candidate_size IS NOT NULL AND candidate_width BETWEEN 1 AND 1600 AND candidate_height=candidate_width AND candidate_size BETWEEN 1 AND 2097152 AND candidate_low_resolution IS NOT NULL)),
 CHECK(state NOT IN ('candidate_ready','approved') OR candidate_asset_id IS NOT NULL),
 CHECK(candidate_asset_id IS NULL OR (candidate_asset_id<>source_asset_id AND candidate_asset_id<>cutout_asset_id))
);
CREATE INDEX IF NOT EXISTS product_shot_attempts_cutout_asset_fk_idx ON product_shot_attempts(workspace_id,listing_id,cutout_asset_id);
CREATE INDEX IF NOT EXISTS product_shot_attempts_candidate_asset_fk_idx ON product_shot_attempts(workspace_id,listing_id,candidate_asset_id);
CREATE TABLE IF NOT EXISTS product_shot_selections (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 listing_id uuid NOT NULL, attempt_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,listing_id),
 FOREIGN KEY(workspace_id,listing_id,attempt_id) REFERENCES product_shot_attempts(workspace_id,listing_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS product_shot_selections_attempt_fk_idx ON product_shot_selections(workspace_id,listing_id,attempt_id);
CREATE TABLE IF NOT EXISTS product_shot_daily_dispatches (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 dispatch_day date NOT NULL, dispatched_count integer NOT NULL CHECK(dispatched_count>0),
 PRIMARY KEY(workspace_id,dispatch_day)
);
CREATE TABLE IF NOT EXISTS product_shot_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 listing_id uuid NOT NULL, attempt_id uuid NOT NULL,
 observed_version_id uuid NOT NULL, version_id uuid NOT NULL,
 asset_id uuid NOT NULL, storage_key text NOT NULL, candidate_digest text NOT NULL CHECK(candidate_digest ~ '^[0-9a-f]{64}$'),
 source_asset_id uuid NOT NULL, source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 provider_version text NOT NULL, render_version text NOT NULL,
 token text NOT NULL UNIQUE CHECK(token ~ '^[0-9a-f]{64}$'),
 token_hash text NOT NULL UNIQUE CHECK(token_hash=encode(sha256(convert_to(token,'UTF8')),'hex')),
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, revoked_by text,
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 FOREIGN KEY(workspace_id,listing_id,attempt_id) REFERENCES product_shot_attempts(workspace_id,listing_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,observed_version_id) REFERENCES listing_versions(workspace_id,listing_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,version_id) REFERENCES listing_versions(workspace_id,listing_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,asset_id) REFERENCES source_assets(workspace_id,listing_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,listing_id,source_asset_id) REFERENCES source_assets(workspace_id,listing_id,id) ON DELETE RESTRICT,
 UNIQUE(workspace_id,attempt_id,version_id,candidate_digest)
);
CREATE INDEX IF NOT EXISTS product_shot_publications_asset_idx ON product_shot_publications(workspace_id,listing_id,version_id,asset_id);
CREATE INDEX IF NOT EXISTS product_shot_publications_asset_fk_idx ON product_shot_publications(workspace_id,listing_id,asset_id);
CREATE INDEX IF NOT EXISTS product_shot_publications_attempt_fk_idx ON product_shot_publications(workspace_id,listing_id,attempt_id);
CREATE INDEX IF NOT EXISTS product_shot_publications_observed_version_fk_idx ON product_shot_publications(workspace_id,listing_id,observed_version_id);
CREATE INDEX IF NOT EXISTS product_shot_publications_source_asset_fk_idx ON product_shot_publications(workspace_id,listing_id,source_asset_id);

DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['product_shot_attempts','product_shot_selections','product_shot_daily_dispatches','product_shot_publications'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS product_shot_workspace ON %I',t);
  EXECUTE format('CREATE POLICY product_shot_workspace ON %I FOR ALL TO wukong_app USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  EXECUTE format('REVOKE ALL ON %I FROM wukong_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO wukong_app',t);
 END LOOP;
END $rls$;
GRANT UPDATE(state,lease_token,lease_expires_at,dispatched_at,call_count,estimated_cost_usd,cutout_asset_id,cutout_digest,candidate_asset_id,candidate_digest,candidate_width,candidate_height,candidate_size,candidate_low_resolution,error_code,updated_at) ON product_shot_attempts TO wukong_app;
GRANT UPDATE(attempt_id,updated_at) ON product_shot_selections TO wukong_app;
GRANT UPDATE(dispatched_count) ON product_shot_daily_dispatches TO wukong_app;
GRANT UPDATE(revoked_at,revoked_by) ON product_shot_publications TO wukong_app;

-- Even privileged maintenance cannot accidentally rewrite published image bindings.
CREATE OR REPLACE FUNCTION guard_product_shot_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'product shot publication is immutable'; END IF;
 IF (to_jsonb(NEW)-'revoked_at'-'revoked_by') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by')
   OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by))
 THEN RAISE EXCEPTION 'product shot publication is immutable'; END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_product_shot_publication() FROM PUBLIC;
DROP TRIGGER IF EXISTS product_shot_publication_immutable ON product_shot_publications;
CREATE TRIGGER product_shot_publication_immutable BEFORE UPDATE OR DELETE ON product_shot_publications FOR EACH ROW EXECUTE FUNCTION guard_product_shot_publication();


-- Attempts bind stored bytes through source_assets. Once referenced, even a
-- maintenance update must not silently substitute another object or metadata.
CREATE OR REPLACE FUNCTION guard_product_shot_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
BEGIN
 IF NEW IS DISTINCT FROM OLD AND EXISTS (
  SELECT 1 FROM product_shot_attempts a WHERE a.workspace_id=OLD.workspace_id
    AND (a.source_asset_id=OLD.id OR a.cutout_asset_id=OLD.id OR a.candidate_asset_id=OLD.id)
 ) THEN RAISE EXCEPTION 'product shot asset is immutable'; END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_product_shot_asset() FROM PUBLIC;
DROP TRIGGER IF EXISTS product_shot_asset_immutable ON source_assets;
CREATE TRIGGER product_shot_asset_immutable BEFORE UPDATE ON source_assets FOR EACH ROW EXECUTE FUNCTION guard_product_shot_asset();

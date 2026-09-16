const tables = [
  "wine_stages",
  "wine_evidence",
  "wine_section_snapshots",
  "wine_source_authorities",
  "wine_trusted_contexts",
  "search_budget_reservations",
  "wine_search_calls",
  "wine_document_requests",
  "wine_evidence_cache",
];
// These are PostgreSQL's canonical definitions of migration 0041, not names alone.
// Only whitespace is normalized; a changed expression or referenced table fails closed.
const payloadCheck =
  "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (NOT ((payload -> 'schemaVersion'::text) IS DISTINCT FROM '1'::jsonb))))";
const constraints: readonly (readonly [string, string, string])[] = [
  [
    "wine_document_requests",
    "wine_document_requests_input_revision_check",
    "CHECK ((input_revision >= 0))",
  ],
  [
    "wine_document_requests",
    "wine_document_requests_kind_check",
    "CHECK ((kind = ANY (ARRAY['robots'::text, 'product'::text])))",
  ],
  [
    "wine_document_requests",
    "wine_document_requests_pkey",
    "PRIMARY KEY (workspace_id, run_id, source_id, kind)",
  ],
  [
    "wine_document_requests",
    "wine_document_requests_state_check",
    "CHECK ((state = ANY (ARRAY['started'::text, 'completed'::text])))",
  ],
  [
    "wine_document_requests",
    "wine_document_requests_workspace_id_fkey",
    "FOREIGN KEY (workspace_id) REFERENCES workspaces(id)",
  ],
  [
    "wine_document_requests",
    "wine_document_result_check",
    "CHECK ((((state = 'started'::text) AND (result IS NULL)) OR ((state = 'completed'::text) AND (result IS NOT NULL) AND (jsonb_typeof(result) = 'object'::text) AND (NOT ((result -> 'schemaVersion'::text) IS DISTINCT FROM '1'::jsonb)) AND (octet_length((result)::text) <= 131072) AND (NOT ((result ->> 'workspaceId'::text) IS DISTINCT FROM workspace_id)) AND (NOT ((result ->> 'runId'::text) IS DISTINCT FROM (run_id)::text)) AND (NOT ((result ->> 'sourceId'::text) IS DISTINCT FROM (source_id)::text)) AND (NOT ((result ->> 'kind'::text) IS DISTINCT FROM kind)) AND (NOT ((result -> 'inputRevision'::text) IS DISTINCT FROM to_jsonb(input_revision))))))",
  ],
  [
    "wine_document_requests",
    "wine_document_source_fk",
    "FOREIGN KEY (workspace_id, run_id, source_id) REFERENCES wine_evidence(workspace_id, run_id, source_id)",
  ],
  [
    "wine_evidence_cache",
    "wine_cache_payload_check",
    "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (NOT ((payload -> 'schemaVersion'::text) IS DISTINCT FROM '1'::jsonb)) AND (octet_length((payload)::text) <= 1048576)))",
  ],
  [
    "wine_evidence_cache",
    "wine_cache_run_fk",
    "FOREIGN KEY (workspace_id, run_id) REFERENCES listing_pipeline_runs(workspace_id, id)",
  ],
  [
    "wine_evidence_cache",
    "wine_evidence_cache_identity_key_check",
    "CHECK (((length(identity_key) >= 1) AND (length(identity_key) <= 500)))",
  ],
  [
    "wine_evidence_cache",
    "wine_evidence_cache_pkey",
    "PRIMARY KEY (workspace_id, snapshot_id)",
  ],
  [
    "wine_evidence_cache",
    "wine_evidence_cache_policy_version_check",
    "CHECK (((length(policy_version) >= 1) AND (length(policy_version) <= 200)))",
  ],
  [
    "wine_evidence_cache",
    "wine_evidence_cache_rules_version_check",
    "CHECK (((length(rules_version) >= 1) AND (length(rules_version) <= 200)))",
  ],
  [
    "wine_evidence_cache",
    "wine_evidence_cache_workspace_id_fkey",
    "FOREIGN KEY (workspace_id) REFERENCES workspaces(id)",
  ],
  [
    "wine_search_calls",
    "wine_calls_output_check",
    "CHECK ((((output IS NULL) OR ((status = 'succeeded'::text) AND (jsonb_typeof(output) = 'object'::text) AND (NOT ((output -> 'schemaVersion'::text) IS DISTINCT FROM '1'::jsonb)) AND (octet_length((output)::text) <= 262144))) AND ((diagnostic IS NULL) OR ((status = ANY (ARRAY['failed'::text, 'unknown'::text])) AND (jsonb_typeof(diagnostic) = 'object'::text) AND (NOT ((diagnostic -> 'schemaVersion'::text) IS DISTINCT FROM '1'::jsonb)) AND (octet_length((diagnostic)::text) <= 2048)))))",
  ],

  [
    "wine_stages",
    "wine_stages_run_fk",
    "FOREIGN KEY (workspace_id, run_id) REFERENCES listing_pipeline_runs(workspace_id, id)",
  ],
  [
    "wine_evidence",
    "wine_evidence_run_fk",
    "FOREIGN KEY (workspace_id, run_id) REFERENCES listing_pipeline_runs(workspace_id, id)",
  ],
  [
    "wine_section_snapshots",
    "wine_sections_run_fk",
    "FOREIGN KEY (workspace_id, listing_id, run_id) REFERENCES listing_pipeline_runs(workspace_id, listing_id, id)",
  ],
  [
    "wine_section_snapshots",
    "wine_sections_version_fk",
    "FOREIGN KEY (workspace_id, listing_id, version_id) REFERENCES listing_versions(workspace_id, listing_id, id)",
  ],
  [
    "wine_trusted_contexts",
    "wine_context_run_fk",
    "FOREIGN KEY (workspace_id, run_id) REFERENCES listing_pipeline_runs(workspace_id, id)",
  ],
  [
    "search_budget_reservations",
    "search_budget_run_fk",
    "FOREIGN KEY (workspace_id, pipeline_run_id) REFERENCES listing_pipeline_runs(workspace_id, id)",
  ],
  [
    "search_budget_reservations",
    "search_budget_units_check",
    "CHECK ((((state = ANY (ARRAY['held'::text, 'unknown'::text])) AND (settled_credits IS NULL)) OR ((state = 'settled'::text) AND (settled_credits IS NOT NULL) AND ((settled_credits >= 0) AND (settled_credits <= reserved_credits)))))",
  ],
  [
    "wine_search_calls",
    "wine_calls_reservation_fk",
    "FOREIGN KEY (workspace_id, run_id) REFERENCES search_budget_reservations(workspace_id, pipeline_run_id)",
  ],
  [
    "wine_search_calls",
    "wine_calls_units_check",
    "CHECK ((((status = ANY (ARRAY['started'::text, 'unknown'::text])) AND (credits IS NULL)) OR ((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) AND (credits IS NOT NULL) AND ((credits >= 0) AND (credits <= maximum_credits)))))",
  ],
  [
    "wine_search_calls",
    "wine_calls_slot_max_check",
    "CHECK ((maximum_credits = CASE WHEN (slot = 'advanced_1'::text) THEN 2 ELSE 1 END))",
  ],
  ...[
    "wine_evidence",
    "wine_section_snapshots",
    "wine_source_authorities",
    "wine_trusted_contexts",
  ].map((table) => [table, `${table}_payload_check`, payloadCheck] as const),
];
const indexes = [
  [
    "wine_cache_lookup_idx",
    "wine_evidence_cache",
    "CREATE INDEX wine_cache_lookup_idx ON public.wine_evidence_cache USING btree (workspace_id, identity_key, policy_version, rules_version, captured_at DESC)",
  ],
  [
    "wine_cache_run_idx",
    "wine_evidence_cache",
    "CREATE INDEX wine_cache_run_idx ON public.wine_evidence_cache USING btree (workspace_id, run_id)",
  ],
] as const;
const policyPredicate = `(workspace_id = ( SELECT NULLIF(current_setting('app.workspace_id'::text, true), ''::text) AS "nullif"))`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const normalized = (value: string) =>
  `regexp_replace(${value}, '[[:space:]]', '', 'g')`;
export async function inspectWineEnrichmentCompatibility(
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
) {
  const rows =
    await query(`WITH required(name) AS (VALUES ${tables.map((t) => `(${literal(t)})`).join(",")}),
 expected_constraint(tab,name,definition) AS (VALUES ${constraints.map((c) => `(${c.map(literal).join(",")})`).join(",")})
 SELECT name AS capability, EXISTS(
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=name AND c.relrowsecurity AND c.relforcerowsecurity
   AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
   AND (has_table_privilege(current_user,c.oid,'UPDATE') = (name IN ('wine_stages','wine_search_calls','search_budget_reservations','wine_document_requests')))
   AND NOT has_table_privilege(current_user,c.oid,'DELETE')
   AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)=1
   AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='wine_workspace_policy'
    AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='wukong_app')]
    AND ${normalized("pg_get_expr(p.polqual,p.polrelid)")}=${normalized(literal(policyPredicate))}
    AND ${normalized("pg_get_expr(p.polwithcheck,p.polrelid)")}=${normalized(literal(policyPredicate))})
   AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='wine_immutable_guard'
    AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27 AND t.tgqual IS NULL AND t.tgnargs=0
    AND t.tgfoid=to_regprocedure(CASE WHEN name='wine_document_requests' THEN 'public.guard_wine_document_terminal()' WHEN name IN ('wine_stages','wine_search_calls','search_budget_reservations')
      THEN 'public.guard_wine_terminal()' ELSE 'public.guard_immutable_enrichment_suggestion()' END))
 ) AS ready FROM required
 UNION ALL SELECT 'wine_cache.source_time_guard',EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.wine_evidence_cache') AND t.tgname='wine_cache_freshness_guard' AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=7 AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgfoid=to_regprocedure('public.guard_wine_cache_freshness()'))
 UNION ALL SELECT 'wine_cache.captured_at_source_owned',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wine_evidence_cache' AND column_name='captured_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default IS NULL)
 UNION ALL SELECT 'runtime_role' ,current_user='wukong_app' AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
 UNION ALL SELECT 'constraint.'||e.tab||'.'||e.name,EXISTS(
  SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||e.tab) AND c.conname=e.name AND c.convalidated
   AND ${normalized("pg_get_constraintdef(c.oid)")}=${normalized("e.definition")}
 ) FROM expected_constraint e
 UNION ALL SELECT 'index.'||e.name,EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.'||e.name) AND i.indrelid=to_regclass('public.'||e.tab) AND i.indisvalid AND i.indisready AND ${normalized("pg_get_indexdef(i.indexrelid)")}=${normalized("e.definition")})
 FROM (VALUES ${indexes.map((i) => `(${i.map(literal).join(",")})`).join(",")}) e(name,tab,definition)
 UNION ALL SELECT 'column.'||tab||'.'||col,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=tab AND column_name=col)
 FROM (VALUES ('wine_stages','dependency_digest'),('wine_stages','output'),('wine_evidence','payload'),('wine_section_snapshots','payload'),('wine_source_authorities','reviewer_id'),('wine_trusted_contexts','input_digest'),('search_budget_reservations','reserved_credits'),('search_budget_reservations','settled_credits'),('wine_search_calls','maximum_credits'),('wine_search_calls','credits'),('wine_search_calls','output'),('wine_search_calls','diagnostic'),('wine_document_requests','input_revision'),('wine_document_requests','result'),('wine_evidence_cache','captured_at'),('wine_evidence_cache','payload')) cols(tab,col)`);
  const missing = rows
    .filter((row) => row.ready !== true)
    .map((row) => String(row.capability));
  if (
    rows.length !==
    tables.length + 3 + constraints.length + 16 + indexes.length
  )
    missing.push("wine.catalog_incomplete");
  return {
    version: "wine-enrichment-0042-v1",
    ready: missing.length === 0,
    missing,
  };
}

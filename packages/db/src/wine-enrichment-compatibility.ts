const tables = [
  "wine_stages",
  "wine_evidence",
  "wine_section_snapshots",
  "wine_source_authorities",
  "wine_trusted_contexts",
  "search_budget_reservations",
  "wine_search_calls",
];
// These are PostgreSQL's canonical definitions of migration 0041, not names alone.
// Only whitespace is normalized; a changed expression or referenced table fails closed.
const payloadCheck =
  "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (NOT ((payload -> 'schemaVersion'::text) IS DISTINCT FROM '1'::jsonb))))";
const constraints: readonly (readonly [string, string, string])[] = [
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
   AND (has_table_privilege(current_user,c.oid,'UPDATE') = (name IN ('wine_stages','wine_search_calls','search_budget_reservations')))
   AND NOT has_table_privilege(current_user,c.oid,'DELETE')
   AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)=1
   AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='wine_workspace_policy'
    AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='wukong_app')]
    AND ${normalized("pg_get_expr(p.polqual,p.polrelid)")}=${normalized(literal(policyPredicate))}
    AND ${normalized("pg_get_expr(p.polwithcheck,p.polrelid)")}=${normalized(literal(policyPredicate))})
   AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='wine_immutable_guard'
    AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27 AND t.tgqual IS NULL AND t.tgnargs=0
    AND t.tgfoid=to_regprocedure(CASE WHEN name IN ('wine_stages','wine_search_calls','search_budget_reservations')
      THEN 'public.guard_wine_terminal()' ELSE 'public.guard_immutable_enrichment_suggestion()' END))
 ) AS ready FROM required
 UNION ALL SELECT 'runtime_role',current_user='wukong_app' AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
 UNION ALL SELECT 'constraint.'||e.tab||'.'||e.name,EXISTS(
  SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||e.tab) AND c.conname=e.name AND c.convalidated
   AND ${normalized("pg_get_constraintdef(c.oid)")}=${normalized("e.definition")}
 ) FROM expected_constraint e
 UNION ALL SELECT 'column.'||tab||'.'||col,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=tab AND column_name=col)
 FROM (VALUES ('wine_stages','dependency_digest'),('wine_stages','output'),('wine_evidence','payload'),('wine_section_snapshots','payload'),('wine_source_authorities','reviewer_id'),('wine_trusted_contexts','input_digest'),('search_budget_reservations','reserved_credits'),('search_budget_reservations','settled_credits'),('wine_search_calls','maximum_credits'),('wine_search_calls','credits')) cols(tab,col)`);
  const missing = rows
    .filter((row) => row.ready !== true)
    .map((row) => String(row.capability));
  if (rows.length !== tables.length + 1 + constraints.length + 10)
    missing.push("wine.catalog_incomplete");
  return {
    version: "wine-enrichment-0041-v1",
    ready: missing.length === 0,
    missing,
  };
}

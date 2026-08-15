import postgres from "postgres";

export const REQUIRED_AUDIT_SEQUENCE = [
  "listing.created",
  "listing.submitted_for_review",
  "listing.edited",
  "listing.approved",
  "listing.csv_exported",
  "listing.publish_queued",
  "listing.published",
] as const;

/**
 * Every workspace-scoped table. The RLS leak probe is generated from this list
 * so adding a tenant table cannot silently narrow the release gate. Names are
 * literals from this module, never user input, so interpolating them is safe.
 */
export const TENANT_TABLES = [
  "memberships",
  "workspace_invites",
  "listing_drafts",
  "listing_versions",
  "source_assets",
  "field_evidence",
  "compliance_flags",
  "prompt_versions",
  "ai_runs",
  "shopline_connections",
  "platform_products",
  "enrichment_batches",
  "enrichment_batch_items",
  "publish_jobs",
  "review_events",
  "audit_events",
  "listing_pipeline_runs",
  "listing_pipeline_steps",
] as const;

export type AuditVerificationResult = {
  workspaceId: string;
  draftId: string;
  actions: string[];
  missingActions: string[];
  aiRunTasks: string[];
  accessibleForeignRecordCount: number;
  accessibleForeignTables: string[];
  passed: boolean;
};

type AuditVerifyInput = { workspaceId: string; draftId: string; url: string };

function readArg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? null;
  const prefix = `${name}=`;
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function requiredSequenceMissing(actions: readonly string[]): string[] {
  const missing: string[] = [];
  let cursor = 0;
  for (const required of REQUIRED_AUDIT_SEQUENCE) {
    const found = actions.findIndex(
      (action, index) => index >= cursor && action === required,
    );
    if (found < 0) missing.push(required);
    else cursor = found + 1;
  }
  return missing;
}

function toCount(row: { count?: unknown }): number {
  const count = Number(row.count ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export async function verifyAudit(
  input: AuditVerifyInput,
): Promise<AuditVerificationResult> {
  if (!input.workspaceId.trim() || !input.draftId.trim())
    throw new Error("workspace and draft are required");
  const client = postgres(input.url, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
  });
  try {
    return await client.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${input.workspaceId}, true)`;
      const auditRows = await transaction<{ action: string }[]>`
        select action
        from audit_events
        where workspace_id = ${input.workspaceId} and entity_id = ${input.draftId}
        order by created_at asc, id asc
      `;
      const aiRows = await transaction<{ task: string }[]>`
        select task
        from ai_runs
        where workspace_id = ${input.workspaceId} and listing_id::text = ${input.draftId}
        order by created_at asc, id asc
      `;
      // Probe every tenant-scoped table, not only rows linked to this draft. RLS
      // should make all rows with another workspace invisible to the runtime role.
      // Running with an admin URL intentionally exposes any leaked foreign rows.
      const probe = [
        `select 'workspaces' as source, count(*)::bigint as count from workspaces where id <> $1`,
        ...TENANT_TABLES.map(
          (table) =>
            `select '${table}', count(*) from ${table} where workspace_id <> $1`,
        ),
      ].join(" union all ");
      const foreignRows = await transaction.unsafe<
        { source: string; count: number }[]
      >(`select source, count::int from (${probe}) as counts where count > 0`, [
        input.workspaceId,
      ]);
      const actions = auditRows.map((row) => row.action);
      const aiRunTasks = aiRows.map((row) => row.task);
      const missingActions = requiredSequenceMissing(actions);
      for (const task of ["extract", "generate"] as const) {
        if (!aiRunTasks.includes(task)) missingActions.push(`ai_runs.${task}`);
      }
      const accessibleForeignRecordCount = foreignRows.reduce(
        (total, row) => total + toCount(row),
        0,
      );
      const accessibleForeignTables = foreignRows.map((row) => row.source);
      return {
        workspaceId: input.workspaceId,
        draftId: input.draftId,
        actions,
        missingActions,
        aiRunTasks,
        accessibleForeignRecordCount,
        accessibleForeignTables,
        passed:
          missingActions.length === 0 && accessibleForeignRecordCount === 0,
      };
    });
  } finally {
    await client.end();
  }
}

export function parseAuditVerifyArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): AuditVerifyInput {
  const workspaceId =
    readArg(args, "--workspace") ?? env.OPAK_WORKSPACE_ID ?? "ws_opak";
  const draftId = readArg(args, "--draft");
  const url = env.DATABASE_URL;
  if (!draftId)
    throw new Error(
      "usage: audit:verify --workspace <workspace-id> --draft <draft-id>",
    );
  if (!url) throw new Error("DATABASE_URL is required");
  return { workspaceId, draftId, url };
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const result = await verifyAudit(parseAuditVerifyArgs(args));
    console.log(`workspace: ${result.workspaceId}`);
    console.log(`draft: ${result.draftId}`);
    console.log(`actions: ${result.actions.join(" -> ") || "(none)"}`);
    console.log(`missing action count: ${result.missingActions.length}`);
    if (result.missingActions.length)
      console.log(`missing: ${result.missingActions.join(", ")}`);
    console.log(
      `accessible foreign record count: ${result.accessibleForeignRecordCount}`,
    );
    if (result.accessibleForeignTables.length)
      console.log(
        `accessible foreign tables: ${result.accessibleForeignTables.join(", ")}`,
      );
    return result.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (
  process.argv[1]?.endsWith("audit-verify.ts") ||
  process.argv[1]?.endsWith("audit-verify.js")
) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

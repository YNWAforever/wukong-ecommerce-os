import postgres from "postgres";

/**
 * The audited lifecycle a draft must be able to show, in order.
 *
 * Each step is a set of interchangeable actions. A draft opens with either
 * `listing.created` (an operator typed the product in) or `listing.imported`
 * (it came from a SHOPLINE bulk update form). The importer records the distinct
 * action deliberately — the two are not the same event and the trail should say
 * which happened — so without the alternative here no imported draft could ever
 * satisfy this gate, however far through the lifecycle it got.
 *
 * The final step is the same shape for the same reason: there are three
 * mutually exclusive ways a listing leaves Wukong, and a draft only ever takes
 * one. `csv_exported` and `bulk_form_exported` are both terminal — the operator
 * downloads a file and uploads it to SHOPLINE by hand, and nothing further is
 * queued or tracked here. Only the `shopline_api` path continues past its own
 * `publish_queued` into `published`, so `published` alone stands in for that
 * whole chain — a listing that reached it necessarily passed through
 * `publish_queued` first. Requiring all three as separate mandatory steps (as
 * this list once did) made the gate unsatisfiable for a listing delivered by
 * only one of the three methods, which is every listing.
 *
 * `listing.edited` is deliberately absent. Editing during review is optional —
 * a listing can be approved on first submission — so requiring it here would
 * make the gate unsatisfiable for a legitimate listing that never needed one.
 */
export const REQUIRED_AUDIT_SEQUENCE = [
  ["listing.created", "listing.imported"],
  ["listing.submitted_for_review"],
  ["listing.approved"],
  ["listing.csv_exported", "listing.bulk_form_exported", "listing.published"],
] as const satisfies readonly (readonly string[])[];

/**
 * Every workspace-scoped table. The RLS leak probe is generated from this list
 * so adding a tenant table cannot silently narrow the release gate. Names are
 * literals from this module, never user input, so interpolating them is safe.
 */
export const TENANT_TABLES = [
  "product_shot_attempts",
  "product_shot_selections",
  "product_shot_daily_dispatches",
  "product_shot_publications",
  "product_shot_approval_urls",
  "website_scans",
  "website_scan_steps",
  "website_products",
  "workbook_imports",
  "workbook_products",
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
  "source_imports",
  "source_row_snapshots",
  "bulk_update_approval_receipts",
  "review_confirmations",
  "export_attempts",
  "export_verifications",
  "import_results",
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

export function requiredSequenceMissing(actions: readonly string[]): string[] {
  const missing: string[] = [];
  let cursor = 0;
  for (const step of REQUIRED_AUDIT_SEQUENCE) {
    const found = actions.findIndex(
      (action, index) =>
        index >= cursor && (step as readonly string[]).includes(action),
    );
    // Reported as "a or b" so the operator sees both spellings that satisfy the
    // step, rather than being sent looking for one the draft never had.
    if (found < 0) missing.push(step.join(" or "));
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
      const auditRows = await transaction<
        { action: string; metadata: Record<string, unknown> }[]
      >`
        select action, metadata
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
      const shots = await transaction<ProductShotAuditAttempt[]>`
        select id, state, dispatched_at as "dispatchedAt", cutout_asset_id as "cutoutAssetId", candidate_asset_id as "candidateAssetId"
        from product_shot_attempts where workspace_id=${input.workspaceId} and listing_id::text=${input.draftId}
      `;
      const shotPublications = await transaction<ProductShotAuditPublication[]>`
        select id, attempt_id as "attemptId", version_id as "versionId", revoked_at as "revokedAt"
        from product_shot_publications where workspace_id=${input.workspaceId} and listing_id::text=${input.draftId}
      `;
      missingActions.push(
        ...productShotAuditMissing(shots, shotPublications, auditRows),
      );
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

/** Website observations have their own lifecycle; no listing approval/export is inferred. */
export async function verifyWebsiteAudit(input: {
  workspaceId: string;
  scanId: string;
  url: string;
}) {
  if (!input.workspaceId.trim() || !input.scanId.trim())
    throw new Error("workspace and scan are required");
  const client = postgres(input.url, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
  });
  try {
    return await client.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${input.workspaceId},true)`;
      const [scan] =
        await tx`select state from website_scans where workspace_id=${input.workspaceId} and id=${input.scanId}`;
      const events =
        await tx`select action,metadata from audit_events where workspace_id=${input.workspaceId} and entity_id=${input.scanId}`;
      const steps =
        await tx`select revision from website_scan_steps where workspace_id=${input.workspaceId} and scan_id=${input.scanId} and request_state='completed'`;
      const products =
        await tx`select id from website_products where workspace_id=${input.workspaceId} and source_scan_id=${input.scanId}`;
      const missingActions: string[] = [];
      if (!scan) missingActions.push("website.scan_missing");
      if (!events.some((e) => e.action === "website.scan_created"))
        missingActions.push("website.scan_created");
      for (const step of steps)
        if (
          !events.some(
            (e) =>
              e.action === "website.scan_step_completed" &&
              e.metadata?.revision === step.revision,
          )
        )
          missingActions.push(`website.scan_step_completed.${step.revision}`);
      if (
        scan &&
        ["ready", "partial", "failed"].includes(String(scan.state)) &&
        !events.some((e) => e.action === "website.scan_finished")
      )
        missingActions.push("website.scan_finished");
      for (const product of products)
        if (
          !events.some(
            (e) =>
              e.action === "website.products_saved" &&
              Array.isArray(e.metadata?.productIds) &&
              e.metadata.productIds.includes(product.id),
          )
        )
          missingActions.push(`website.products_saved.${product.id}`);
      const probe = [
        `select 'workspaces' as source,count(*)::bigint as count from workspaces where id<>$1`,
        ...TENANT_TABLES.map(
          (t) => `select '${t}',count(*) from ${t} where workspace_id<>$1`,
        ),
      ].join(" union all ");
      const foreign = await tx.unsafe<{ source: string; count: number }[]>(
        `select source,count::int from (${probe}) counts where count>0`,
        [input.workspaceId],
      );
      return {
        workspaceId: input.workspaceId,
        scanId: input.scanId,
        missingActions,
        accessibleForeignRecordCount: foreign.reduce(
          (n, r) => n + toCount(r),
          0,
        ),
        accessibleForeignTables: foreign.map((r) => r.source),
        passed: missingActions.length === 0 && foreign.length === 0,
      };
    });
  } finally {
    await client.end();
  }
}

type ProductShotAuditAttempt = {
  id: string;
  state: string;
  dispatchedAt: Date | null;
  cutoutAssetId: string | null;
  candidateAssetId: string | null;
};
type ProductShotAuditPublication = {
  id: string;
  attemptId: string;
  versionId: string;
  revokedAt: Date | null;
};
/** Optional image workflow: verify retained checkpoints by attempt and exact version,
 * so one successful attempt cannot hide a missing event on another attempt. */
export function productShotAuditMissing(
  attempts: readonly ProductShotAuditAttempt[],
  publications: readonly ProductShotAuditPublication[],
  events: readonly {
    action: string;
    metadata: Record<string, unknown> | null;
  }[],
): string[] {
  const missing: string[] = [];
  const has = (
    action: string,
    attemptId: string,
    versionId?: string,
    publicationId?: string,
  ) =>
    events.some(
      (event) =>
        event.action === "product_shot." + action &&
        event.metadata?.attemptId === attemptId &&
        (versionId === undefined || event.metadata.versionId === versionId) &&
        (publicationId === undefined ||
          event.metadata.publicationId === publicationId),
    );
  for (const attempt of attempts) {
    const required = ["requested"];
    if (attempt.dispatchedAt) required.push("dispatched");
    if (attempt.cutoutAssetId) required.push("cutout_saved");
    if (attempt.candidateAssetId) required.push("candidate_saved");
    if (attempt.state === "failed" || attempt.state === "outcome_unknown")
      required.push(attempt.state);
    for (const action of required)
      if (!has(action, attempt.id))
        missing.push(`product_shot.${action}:${attempt.id}`);
  }
  for (const publication of publications) {
    if (!has("approved", publication.attemptId, publication.versionId))
      missing.push(`product_shot.approved:${publication.id}`);
    if (
      publication.revokedAt &&
      !has(
        "revoked",
        publication.attemptId,
        publication.versionId,
        publication.id,
      )
    )
      missing.push(`product_shot.revoked:${publication.id}`);
  }
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  const replaced = new Set(
    events
      .filter(
        (event) =>
          event.action === "product_shot.source_replaced" &&
          typeof event.metadata?.attemptId === "string" &&
          typeof event.metadata.previousAttemptId === "string" &&
          event.metadata.attemptId !== event.metadata.previousAttemptId &&
          attemptIds.has(event.metadata.attemptId) &&
          attemptIds.has(event.metadata.previousAttemptId),
      )
      .map((event) => event.metadata!.attemptId),
  );
  if (replaced.size < attempts.length - 1)
    missing.push("product_shot.source_replaced");
  return missing;
}

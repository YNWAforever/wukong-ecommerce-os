import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  wineBudgetSnapshotSchema,
  wineEnrichmentPolicySchema,
} from "@wukong/core";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import type {
  Database,
  WorkspaceScope,
  WorkspaceTransaction,
} from "../client.js";
import {
  createAiRunRepository,
  type FinalizeAiInvocationInput,
} from "./ai-runs.js";
import {
  createAiBudgetReservationRepository,
  workspaceAiBudgetChargeSql,
} from "./ai-budget-reservations.js";
const stages = {
  extraction: "extract",
  verification: "verify",
  verification_deep: "verify",
  generation: "generate",
  quality_check: "check",
} as const;
export type WineGoStage = keyof typeof stages;
export type WineGoCoordinates = {
  workspaceId: string;
  runId: string;
  inputRevision: number;
};
export type WineGoCall = {
  stage: WineGoStage;
  callOrdinal: 1 | 2;
  promptVersion: string;
};
export type WineGoCompletion = WineGoCall &
  Omit<FinalizeAiInvocationInput, "pipelineRunId" | "stage" | "callOrdinal"> & {
    schemaRepairEligible?: boolean;
  };
const callSchema = z.object({
  stage: z.enum([
    "extraction",
    "verification",
    "verification_deep",
    "generation",
    "quality_check",
  ]),
  callOrdinal: z.union([z.literal(1), z.literal(2)]),
  promptVersion: z.string().min(1).max(128),
});
const goSchema = z.strictObject({
  schemaVersion: z.literal(1),
  flowVersion: z.literal("wine-enrichment-v1"),
  provider: z.literal("opencode-go"),
  model: z.literal("deepseek-v4.1-flash"),
  contractVersion: z.literal("wine-contract@1"),
  rulesVersion: z.literal("wine-grounding@1"),
  maxOutputTokens: z.literal(4096),
  promptVersions: z.strictObject({
    extract: z.string().min(1).max(128),
    verify: z.string().min(1).max(128),
    generate: z.string().min(1).max(128),
    check: z.string().min(1).max(128),
  }),
});
const repairMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  wineInvocation: z.strictObject({
    schemaVersion: z.literal(1),
    schemaRepairEligible: z.literal(true),
  }),
});
function sameDomains(a: readonly string[], b: readonly string[]) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
// Fixed reviewed Go bounds/rates; server-editable fields never supply accounting estimates.
const reviewedGo = wineEnrichmentPolicySchema.parse({});
function financialAnomaly(
  rows: Record<string, unknown>[],
  reservedUsd: string,
): boolean {
  let totalMicros = 0;
  for (const row of rows) {
    if (row.usage_certainty === "unknown" || row.estimated_cost_usd === null)
      continue;
    const input = Number(row.input_tokens),
      output = Number(row.output_tokens),
      cost = Number(row.estimated_cost_usd);
    if (
      row.input_tokens === null ||
      row.output_tokens === null ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      input < 0 ||
      output < 0 ||
      input > reviewedGo.maxInputTokens ||
      output > reviewedGo.maxOutputTokens ||
      !Number.isFinite(cost) ||
      cost < 0
    )
      return true;
    const expected = Number(
      (
        (input * reviewedGo.inputUsdPerMillion +
          output * reviewedGo.outputUsdPerMillion) /
        1_000_000
      ).toFixed(6),
    );
    if (cost !== expected) return true;
    totalMicros += Math.round(cost * 1_000_000);
  }
  return totalMicros > Math.round(Number(reservedUsd) * 1_000_000);
}
export function createWineGoInvocationRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  const invocations = createAiRunRepository(tx, workspaceId, scope);
  return {
    async admit(
      input: WineGoCoordinates,
      raw: WineGoCall,
    ): Promise<{ claimed: boolean }> {
      scope.assertOpen();
      const deny = { claimed: false };
      const parsed = callSchema.safeParse(raw);
      if (input.workspaceId !== workspaceId || !parsed.success) return deny;
      const call = parsed.data;
      // Listing -> run -> workspace -> reservation matches accepted operation budget ordering.
      const drafts = await tx.execute(
        sql`select d.* from listing_drafts d join listing_pipeline_runs r on r.workspace_id=d.workspace_id and r.listing_id=d.id where r.workspace_id=${workspaceId} and r.id=${input.runId} for update of d`,
      );
      if (!drafts[0]) return deny;
      const runs = await tx.execute(
        sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and id=${input.runId} for update`,
      );
      const run = runs[0]!,
        draft = drafts[0],
        e = run.execution as Record<string, unknown>;
      const budget = wineBudgetSnapshotSchema.safeParse(e.wineBudget),
        policy = wineEnrichmentPolicySchema.safeParse(e.wineEnrichment),
        acquisition = wineAcquisitionPolicySchema.safeParse(e.wineAcquisition),
        go = goSchema.safeParse(e.wineGo);
      if (
        !budget.success ||
        !policy.success ||
        !acquisition.success ||
        !go.success ||
        e.schemaVersion !== 1 ||
        e.flowVersion !== "wine-enrichment-v1" ||
        e.wineMode !== budget.data.mode ||
        !policy.data.enabled ||
        !["queued", "running"].includes(String(run.execution_state)) ||
        run.input_revision !== input.inputRevision ||
        draft.input_revision !== input.inputRevision ||
        draft.current_run_id !== input.runId
      )
        return deny;
      const p = policy.data,
        a = acquisition.data,
        g = go.data,
        b = budget.data;
      // Persist the complete parsed server policy: omitted defaults are not an accepted snapshot.
      if (
        Object.keys(p).some((key) => !(key in (e.wineEnrichment as object))) ||
        (["full", "research"].includes(b.mode) &&
          a.allowedDomains.length === 0) ||
        a.policyVersion !== p.policyVersion ||
        a.rulesVersion !== p.rulesVersion ||
        !sameDomains(a.allowedDomains, p.allowedDomains) ||
        g.rulesVersion !== p.rulesVersion ||
        g.provider !== p.provider ||
        g.model !== p.model ||
        g.promptVersions[stages[call.stage]] !== call.promptVersion ||
        (b.goPhysicalCalls === 4 &&
          !["generation", "quality_check"].includes(call.stage))
      )
        return deny;
      await tx.execute(
        sql`select id from workspaces where id=${workspaceId} for no key update`,
      );
      const reservations = await tx.execute(
        sql`select * from ai_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${input.runId} for update`,
      );
      const reservation = reservations[0];
      if (
        !reservation ||
        reservation.state !== "held" ||
        Number(reservation.reserved_usd) !== Number(b.goReservedUsd) ||
        reservation.pricing_version !== p.policyVersion
      )
        return deny;
      const rows = await tx.execute(
        sql`select * from ai_runs where workspace_id=${workspaceId} and pipeline_run_id=${input.runId}`,
      );
      if (financialAnomaly(rows, b.goReservedUsd)) {
        await createAiBudgetReservationRepository(
          tx,
          workspaceId,
          scope,
        ).settle({
          pipelineRunId: input.runId,
          outcome: "unknown",
          settledUsd: null,
        });
        return deny;
      }
      if (
        rows.length >= b.goPhysicalCalls ||
        rows.some(
          (r) =>
            r.status === "started" ||
            r.usage_certainty === "unknown" ||
            r.estimated_cost_usd === null ||
            (r.stage === call.stage && r.call_ordinal === call.callOrdinal),
        )
      )
        return deny;
      if (
        call.callOrdinal === 2 &&
        !rows.some(
          (r) =>
            r.stage === call.stage &&
            r.call_ordinal === 1 &&
            r.status === "failed" &&
            r.failure_category === "invalid_output" &&
            r.http_status === 200 &&
            repairMetadataSchema.safeParse(r.output).success &&
            r.provider === g.provider &&
            r.model === g.model &&
            (r.input as Record<string, unknown>)?.promptVersion ===
              call.promptVersion,
        )
      )
        return deny;
      const charge = await tx.execute(
        sql`select ${workspaceAiBudgetChargeSql(workspaceId)} as usd`,
      );
      if (Number(charge[0]!.usd) > Number(p.budgetCapUsd)) return deny;
      // Read the real clock after ALL waits, immediately before durable insertion.
      const clock = await tx.execute(sql`select clock_timestamp() as time`);
      const now = new Date(clock[0]!.time as string).getTime(),
        accepted = new Date(run.created_at as string).getTime(),
        deadline = Date.parse(a.deadlineAt);
      if (!(
        deadline > accepted &&
        deadline - accepted <= 900000 &&
        now >= accepted &&
        now < deadline
      ))
        return deny;
      return invocations.beginInvocation({
        listingId: String(run.listing_id),
        pipelineRunId: input.runId,
        stage: call.stage,
        callOrdinal: call.callOrdinal,
        task:
          call.stage === "extraction"
            ? "extract"
            : call.stage === "generation"
              ? "generate"
              : call.stage === "quality_check"
                ? "wine_quality_check"
                : "wine_verification",
        provider: g.provider,
        model: g.model,
        promptVersion: call.promptVersion,
      });
    },
    async finish(
      input: WineGoCoordinates,
      call: WineGoCompletion,
    ): Promise<boolean> {
      scope.assertOpen();
      if (
        input.workspaceId !== workspaceId ||
        !callSchema.safeParse(call).success
      )
        return false;
      const unknown = call.usageCertainty === "unknown";
      if (
        (call.schemaRepairEligible !== undefined &&
          typeof call.schemaRepairEligible !== "boolean") ||
        (call.schemaRepairEligible === true &&
          (call.callOrdinal !== 1 ||
            call.status !== "failed" ||
            call.failureCategory !== "invalid_output" ||
            call.httpStatus !== 200 ||
            unknown))
      )
        throw new Error("invalid wine Go repair eligibility");
      if (
        !["succeeded", "failed"].includes(call.status) ||
        !["unknown", "estimated", "measured"].includes(call.usageCertainty) ||
        !Number.isFinite(call.latencyMs) ||
        call.latencyMs < 0 ||
        ![call.inputTokens, call.outputTokens].every(
          (v) => v === null || (Number.isSafeInteger(v) && v >= 0),
        ) ||
        (unknown
          ? call.estimatedCostUsd !== null
          : call.inputTokens === null ||
            call.outputTokens === null ||
            typeof call.estimatedCostUsd !== "string" ||
            !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(call.estimatedCostUsd))
      )
        throw new Error("invalid wine Go usage");
      // Do not fence terminal usage on current state/deadline. Only the committed run/slot binding.
      const rows = await tx.execute(
        sql`select a.id,r.execution from ai_runs a join listing_pipeline_runs r on r.workspace_id=a.workspace_id and r.id=a.pipeline_run_id where a.workspace_id=${workspaceId} and a.pipeline_run_id=${input.runId} and r.input_revision=${input.inputRevision} and a.stage=${call.stage} and a.call_ordinal=${call.callOrdinal} and a.input->>'promptVersion'=${call.promptVersion} and a.status='started'`,
      );
      if (!rows[0]) return false;
      // Serialize observed-spend publication with new reservations and wine admission.
      await tx.execute(
        sql`select id from workspaces where id=${workspaceId} for no key update`,
      );
      const output = {
        schemaVersion: 1,
        wineInvocation: {
          schemaVersion: 1,
          schemaRepairEligible: call.schemaRepairEligible === true,
        },
      };
      const updated = await tx.execute(
        sql`update ai_runs set status=${call.status},input_tokens=${call.inputTokens},output_tokens=${call.outputTokens},latency_ms=${call.latencyMs},estimated_cost_usd=${call.estimatedCostUsd}::numeric,usage_certainty=${call.usageCertainty},failure_category=${call.failureCategory ?? null},http_status=${call.httpStatus ?? null},provider_code=${call.providerCode ?? null},provider_request_id=${call.providerRequestId ?? null},output=${JSON.stringify(output)}::jsonb,completed_at=now() where workspace_id=${workspaceId} and pipeline_run_id=${input.runId} and stage=${call.stage} and call_ordinal=${call.callOrdinal} and status='started' returning id`,
      );
      const saved = Boolean(updated[0]);
      if (saved) {
        const ledger = await tx.execute(
          sql`select * from ai_runs where workspace_id=${workspaceId} and pipeline_run_id=${input.runId}`,
        );
        const acceptedBudget = wineBudgetSnapshotSchema.safeParse(
          (rows[0]!.execution as Record<string, unknown>).wineBudget,
        );
        const budgetRepository = createAiBudgetReservationRepository(
          tx,
          workspaceId,
          scope,
        );
        if (
          !acceptedBudget.success ||
          financialAnomaly(ledger, acceptedBudget.data.goReservedUsd)
        ) {
          // Preserve actual tokens/cost. The full hold remains unknown until explicit reconciliation.
          await budgetRepository.settle({
            pipelineRunId: input.runId,
            outcome: "unknown",
            settledUsd: null,
          });
        } else if (unknown)
          await budgetRepository.settleFromInvocations(input.runId);
      }
      return saved;
    },
  };
}
/** Awaiting either method includes the workspace transaction COMMIT, before provider I/O. */
export function createWineGoStore(db: Pick<Database, "forWorkspace">) {
  return {
    admit: (input: WineGoCoordinates, call: WineGoCall) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineGoInvocations.admit(input, call),
      ),
    finish: (input: WineGoCoordinates, call: WineGoCompletion) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineGoInvocations.finish(input, call),
      ),
  };
}
export type WineGoStore = ReturnType<typeof createWineGoStore>;

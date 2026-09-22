import { sql } from "drizzle-orm";
import { z } from "zod";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import type { EvidenceSource } from "@wukong/core";
import type {
  Database,
  WorkspaceScope,
  WorkspaceTransaction,
} from "../client.js";
import {
  createWineEnrichmentRepository,
  type SearchCall,
  type SearchCallRecord,
  type WineEnrichmentRepository,
} from "./wine-enrichment.js";
import { createSearchBudgetReservationRepository } from "./search-budget-reservations.js";
import type { WineCacheKey } from "./wine-acquisition.js";
export type WineAcquisitionCoordinates = {
  workspaceId: string;
  runId: string;
  inputRevision: number;
  policyDigest: string;
  rulesVersion: string;
  allowedDomains: string[];
};
export type WinePhysicalCall = Omit<SearchCall, "runId">;
export type WineCallCompletion = Omit<
  Parameters<WineEnrichmentRepository["finishSearchCall"]>[0],
  "runId"
>;
export type WineCallAdmission =
  | { state: "claimed" }
  | { state: "completed"; record: SearchCallRecord }
  | { state: "blocked" | "unknown" };
export const wineDeepSearchDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  required: z.literal(true),
  reasons: z
    .array(z.enum(["identity_gap", "core_fact_gap", "conflict"]))
    .min(1)
    .max(3),
});
export function createWineAcquisitionCallGuard(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  const enrichment = createWineEnrichmentRepository(tx, workspaceId, scope),
    budget = createSearchBudgetReservationRepository(tx, workspaceId, scope);
  async function authorize(input: WineAcquisitionCoordinates) {
    scope.assertOpen();
    if (input.workspaceId !== workspaceId) return null;
    const drafts = await tx.execute(
      sql`select d.* from listing_drafts d join listing_pipeline_runs r on r.workspace_id=d.workspace_id and r.listing_id=d.id where r.workspace_id=${workspaceId} and r.id=${input.runId} for update of d`,
    );
    if (!drafts[0]) return null;
    const runs = await tx.execute(
      sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and id=${input.runId} for update`,
    );
    const r = runs[0]!,
      d = drafts[0],
      execution = r.execution as Record<string, unknown>;
    const policy = wineAcquisitionPolicySchema.safeParse(
      execution?.wineAcquisition,
    );
    const clock = await tx.execute(sql`select clock_timestamp() as time`),
      now = new Date(clock[0]!.time as string).getTime(),
      accepted = new Date(r.created_at as string).getTime();
    if (
      !policy.success ||
      policy.data.allowedDomains.length === 0 ||
      execution.schemaVersion !== 1 ||
      execution.flowVersion !== "wine-enrichment-v1" ||
      !["full", "research"].includes(String(execution.wineMode)) ||
      !["queued", "running"].includes(String(r.execution_state)) ||
      r.input_revision !== input.inputRevision ||
      d.input_revision !== input.inputRevision ||
      d.current_run_id !== input.runId
    )
      return null;
    const p = policy.data,
      deadline = Date.parse(p.deadlineAt);
    if (
      !(
        deadline > accepted &&
        deadline - accepted <= 900000 &&
        now >= accepted &&
        now < deadline
      ) ||
      p.policyVersion !== input.policyDigest ||
      p.rulesVersion !== input.rulesVersion ||
      JSON.stringify([...p.allowedDomains].sort()) !==
        JSON.stringify([...input.allowedDomains].sort())
    )
      return null;
    return {
      ...p,
      now: new Date(now).toISOString(),
      acceptedAt: new Date(accepted).toISOString(),
    };
  }
  return {
    authorizeAcquisition: authorize,
    async admitAcquisitionCall(
      input: WineAcquisitionCoordinates,
      call: WinePhysicalCall,
    ): Promise<WineCallAdmission> {
      if (!(await authorize(input))) return { state: "blocked" };
      const maximum = { basic_1: 1, basic_2: 1, advanced_1: 2, extract_1: 1 }[
        call.slot
      ];
      if (
        maximum !== call.maximumCredits ||
        !call.requestDigest ||
        call.requestDigest.length > 500
      )
        return { state: "blocked" };
      const existing = await enrichment.readSearchCall(input.runId, call.slot);
      if (existing) {
        if (
          existing.requestDigest !== call.requestDigest ||
          existing.maximumCredits !== call.maximumCredits
        )
          return { state: "blocked" };
        return existing.status === "succeeded" && existing.output
          ? { state: "completed", record: existing }
          : { state: "unknown" };
      }
      const uncertain = await tx.execute(
        sql`select slot from wine_search_calls where workspace_id=${workspaceId} and run_id=${input.runId} and (status in ('started','unknown') or credits is null or output is null) limit 1`,
      );
      if (uncertain[0]) return { state: "blocked" };
      if (call.slot === "advanced_1") {
        const verification = await enrichment.readStage(
          input.runId,
          "verification",
        );
        const output = verification?.output as {
          schemaVersion?: unknown;
          deepSearchDecision?: unknown;
        } | null;
        if (
          verification?.state !== "succeeded" ||
          output?.schemaVersion !== 1 ||
          !wineDeepSearchDecisionSchema.safeParse(output.deepSearchDecision)
            .success
        )
          return { state: "blocked" };
      }
      // Acquire the final admission lock before reading the database clock again.
      await tx.execute(
        sql`select pipeline_run_id from search_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${input.runId} for update`,
      );
      // Recheck database clock immediately before beginning the durable physical slot.
      if (!(await authorize(input))) return { state: "blocked" };
      return (await enrichment.beginSearchCall({ ...call, runId: input.runId }))
        ? { state: "claimed" }
        : { state: "blocked" };
    },
    async finishAcquisitionCall(
      input: WineAcquisitionCoordinates,
      call: WineCallCompletion,
    ) {
      // Usage must survive cancellation/deadline: it belongs to an already committed slot.
      scope.assertOpen();
      if (input.workspaceId !== workspaceId) return false;
      const saved = await enrichment.finishSearchCall({
        ...call,
        runId: input.runId,
      });
      if (saved && call.status === "unknown")
        await budget.settleFromCalls(input.runId);
      return saved;
    },
  };
}
/** Every public method resolves only after the outer workspace transaction commits. */
export function createWineEvidenceStore(db: Pick<Database, "forWorkspace">) {
  return {
    context: (input: WineAcquisitionCoordinates) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineAcquisition.authorizeAcquisition(input),
      ),
    admit: (input: WineAcquisitionCoordinates, call: WinePhysicalCall) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineAcquisition.admitAcquisitionCall(input, call),
      ),
    finish: (input: WineAcquisitionCoordinates, call: WineCallCompletion) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineAcquisition.finishAcquisitionCall(input, call),
      ),
    authorities: (input: WineAcquisitionCoordinates) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineEnrichment.readAuthorities(),
      ),
    readEvidence: (input: WineAcquisitionCoordinates) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineEnrichment.readEvidence(input.runId),
      ),
    saveEvidence: (
      input: WineAcquisitionCoordinates,
      sources: EvidenceSource[],
    ) =>
      db.forWorkspace(input.workspaceId, async (r) => {
        if (!(await r.wineAcquisition.authorizeAcquisition(input)))
          throw new Error("stale wine acquisition");
        await r.wineEnrichment.saveEvidence(input.runId, sources);
      }),
    cache: (input: WineAcquisitionCoordinates, key: WineCacheKey) =>
      db.forWorkspace(input.workspaceId, (r) =>
        r.wineAcquisition.readCacheSnapshot(key),
      ),
    saveCache: (
      input: WineAcquisitionCoordinates,
      key: WineCacheKey,
      snapshotId: string,
      sourceIds: string[],
    ) =>
      db.forWorkspace(input.workspaceId, async (r) => {
        if (!(await r.wineAcquisition.authorizeAcquisition(input)))
          throw new Error("stale wine acquisition");
        return r.wineAcquisition.saveCacheSnapshot({
          ...key,
          snapshotId,
          runId: input.runId,
          sourceIds,
        });
      }),
  };
}
export type WineEvidenceStore = ReturnType<typeof createWineEvidenceStore>;

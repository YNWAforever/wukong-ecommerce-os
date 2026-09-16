import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
export type SearchBudgetReservationRepository = {
  reserve(input: {
    pipelineRunId: string;
    reservedCredits: number;
    workspaceCapCredits: number;
    policyVersion: string;
  }): Promise<{ accepted: boolean; state: string }>;
  settleFromCalls(runId: string): Promise<"settled" | "unknown">;
};
export function createSearchBudgetReservationRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): SearchBudgetReservationRepository {
  return {
    async reserve(input) {
      scope.assertOpen();
      if (
        !Number.isSafeInteger(input.reservedCredits) ||
        input.reservedCredits < 1 ||
        input.reservedCredits > 2147483647 ||
        !Number.isSafeInteger(input.workspaceCapCredits) ||
        input.workspaceCapCredits < 0 ||
        input.workspaceCapCredits > 2147483647 ||
        !input.policyVersion ||
        input.policyVersion.length > 128
      )
        throw new Error("invalid credit reservation");
      await tx.execute(
        sql`select id from workspaces where id=${workspaceId} for no key update`,
      );
      const existing = await tx.execute(
        sql`select state,reserved_credits,policy_version from search_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${input.pipelineRunId}`,
      );
      if (existing[0]) {
        if (
          existing[0].reserved_credits !== input.reservedCredits ||
          existing[0].policy_version !== input.policyVersion
        )
          throw new Error("immutable credit reservation");
        return { accepted: true, state: String(existing[0].state) };
      }
      const rows =
        await tx.execute(sql`insert into search_budget_reservations(workspace_id,pipeline_run_id,policy_version,reserved_credits)
    select ${workspaceId},${input.pipelineRunId},${input.policyVersion},${input.reservedCredits}
    where (select coalesce(sum(case when state='settled' then settled_credits else reserved_credits end),0) from search_budget_reservations where workspace_id=${workspaceId})+${input.reservedCredits} <= ${input.workspaceCapCredits} returning state`);
      return {
        accepted: !!rows[0],
        state: rows[0] ? "held" : "budget_blocked",
      };
    },
    async settleFromCalls(runId) {
      scope.assertOpen();
      // The same reservation lock is taken by beginSearchCall; no new slot can race release.
      const reservation = await tx.execute(
        sql`select state from search_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${runId} for update`,
      );
      if (!reservation[0]) throw new Error("search reservation missing");
      if (reservation[0].state !== "held")
        return reservation[0].state as "settled" | "unknown";
      const rows =
        await tx.execute(sql`with usage as(select coalesce(bool_or(status in ('started','unknown') or credits is null),false) uncertain,coalesce(sum(credits),0)::integer total from wine_search_calls where workspace_id=${workspaceId} and run_id=${runId})
    update search_budget_reservations set state=case when usage.uncertain then 'unknown' else 'settled' end,settled_credits=case when usage.uncertain then null else usage.total end,updated_at=now() from usage where workspace_id=${workspaceId} and pipeline_run_id=${runId} returning state`);
      return rows[0]!.state as "settled" | "unknown";
    },
  };
}

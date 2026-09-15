import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";

const MONEY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;
function money(value: string, name: string, allowZero = false): string {
  if (
    !MONEY.test(value) ||
    (allowZero ? Number(value) < 0 : Number(value) <= 0)
  )
    throw new Error(`${name} must be a positive decimal string`);
  return value;
}

export type AiBudgetReservationRepository = {
  reserve(input: {
    pipelineRunId: string;
    reservedUsd: string;
    workspaceCapUsd: string;
    pricingVersion: string;
  }): Promise<{ accepted: boolean; state: string }>;
  settleFromInvocations(pipelineRunId: string): Promise<"settled" | "unknown">;
  settle(input: {
    pipelineRunId: string;
    settledUsd: string | null;
    outcome: "settled" | "unknown";
  }): Promise<void>;
};

export function createAiBudgetReservationRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): AiBudgetReservationRepository {
  return {
    async reserve(input) {
      scope.assertOpen();
      const reserved = money(input.reservedUsd, "reservedUsd");
      const cap = money(input.workspaceCapUsd, "workspaceCapUsd");
      if (!input.pricingVersion || input.pricingVersion.length > 128)
        throw new Error("pricingVersion is required");
      await transaction.execute(
        sql`select id from workspaces where id=${workspaceId} for update`,
      );
      const existing = await transaction.execute(
        sql`select state from ai_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${input.pipelineRunId}`,
      );
      if (existing[0])
        return { accepted: true, state: String(existing[0].state) };
      const inserted = await transaction.execute(sql`
        insert into ai_budget_reservations(workspace_id,pipeline_run_id,pricing_version,reserved_usd,state)
        select ${workspaceId},${input.pipelineRunId},${input.pricingVersion},${reserved}::numeric,'held'
        where (select coalesce(sum(case when state in ('held','unknown') then reserved_usd when state='settled' then settled_usd else 0 end),0) from ai_budget_reservations where workspace_id=${workspaceId}) + ${reserved}::numeric <= ${cap}::numeric
        returning state
      `);
      return inserted[0]
        ? { accepted: true, state: "held" }
        : { accepted: false, state: "budget_blocked" };
    },
    async settleFromInvocations(pipelineRunId) {
      scope.assertOpen();
      const updated = await transaction.execute(sql`
        with calls as (
          select count(*)::int call_count,
            bool_or(status='started' or estimated_cost_usd is null) has_unknown,
            sum(estimated_cost_usd) settled
          from ai_runs where workspace_id=${workspaceId} and pipeline_run_id=${pipelineRunId}
        )
        update ai_budget_reservations r set
          state=case when calls.call_count=0 or calls.has_unknown then 'unknown' else 'settled' end,
          settled_usd=case when calls.call_count=0 or calls.has_unknown then null else calls.settled end,
          updated_at=now()
        from calls where r.workspace_id=${workspaceId} and r.pipeline_run_id=${pipelineRunId} and r.state='held'
        returning r.state
      `);
      if (updated[0]) return String(updated[0].state) as "settled" | "unknown";
      // Terminal delivery is replayable. Return the already-derived outcome;
      // an absent row is the fake-provider case and has no money to release.
      const existing = await transaction.execute(sql`
        select state from ai_budget_reservations
        where workspace_id=${workspaceId} and pipeline_run_id=${pipelineRunId}
          and state in ('settled','unknown')`);
      return existing[0]?.state === "settled" ? "settled" : "unknown";
    },
    async settle(input) {
      scope.assertOpen();
      const settled =
        input.settledUsd === null
          ? null
          : money(input.settledUsd, "settledUsd", true);
      if (input.outcome === "settled" && settled === null)
        throw new Error("settledUsd is required");
      await transaction.execute(
        sql`update ai_budget_reservations set state=${input.outcome},settled_usd=${settled}::numeric,updated_at=now() where workspace_id=${workspaceId} and pipeline_run_id=${input.pipelineRunId} and state='held' returning id`,
      );
    },
  };
}

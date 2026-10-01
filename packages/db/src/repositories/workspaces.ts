import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  workspaceProfileSchema,
  type WorkspaceProfile,
  type WorkspacePolicy,
} from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { workspaces } from "../schema.js";

export type WorkspaceReadinessObservations = {
  reviewerCount: number;
  connectionPresent: boolean;
  latestAi: {
    provider: string;
    model: string;
    status: string;
    checkedAt: Date;
  } | null;
  latestQueueStep: { state: string; checkedAt: Date } | null;
};

export type WorkspaceRepository = {
  requireProfile(): Promise<WorkspaceProfile>;
  readinessObservations(): Promise<WorkspaceReadinessObservations>;
  updateProfile(profile: WorkspaceProfile): Promise<void>;
  updateSettings(
    patch: Partial<WorkspacePolicy> & { brandBackgroundColor?: string | null },
    expectedDigest?: string,
  ): Promise<WorkspaceProfile>;
  usageSummary(): Promise<{
    heldUsd: string;
    unknownHeldUsd: string;
    settledUsd: string;
    unknownRuns: number;
    physicalCalls: number;
  } | null>;
};

export function createWorkspaceRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceRepository {
  return {
    async requireProfile() {
      scope.assertOpen();
      const [workspace] = await transaction
        .select({ profile: workspaces.profile })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace) throw new Error("workspace not found");
      return workspaceProfileSchema.parse(workspace.profile);
    },
    async readinessObservations() {
      scope.assertOpen();
      // Only status, time and counts leave the repository. Never select tokens,
      // provider errors, prompts, job payloads, or member identities here.
      const [row] = await transaction.execute(sql`
        select
          (select count(*)::int from memberships where workspace_id=${workspaceId} and role in ('reviewer','admin','owner')) as reviewer_count,
          exists(select 1 from shopline_connections where workspace_id=${workspaceId}) as connection_present,
          (select jsonb_build_object('provider',provider,'model',model,'status',status,'checkedAt',completed_at) from ai_runs where workspace_id=${workspaceId} and completed_at is not null order by completed_at desc,id desc limit 1) as latest_ai,
          (select jsonb_build_object('state',state,'checkedAt',updated_at) from listing_pipeline_steps where workspace_id=${workspaceId} order by updated_at desc,id desc limit 1) as latest_queue_step
      `);
      const ai = row?.latest_ai as {
        provider: string;
        model: string;
        status: string;
        checkedAt: string;
      } | null;
      const queue = row?.latest_queue_step as {
        state: string;
        checkedAt: string;
      } | null;
      return {
        reviewerCount: Number(row?.reviewer_count ?? 0),
        connectionPresent: row?.connection_present === true,
        latestAi: ai ? { ...ai, checkedAt: new Date(ai.checkedAt) } : null,
        latestQueueStep: queue
          ? { ...queue, checkedAt: new Date(queue.checkedAt) }
          : null,
      };
    },
    async updateSettings(patch, expectedDigest) {
      scope.assertOpen();
      const [row] = await transaction
        .select({ profile: workspaces.profile })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      if (!row) throw new Error("workspace not found");
      const current = workspaceProfileSchema.parse(row.profile);
      if (
        expectedDigest &&
        createHash("sha256").update(JSON.stringify(current)).digest("hex") !==
          expectedDigest
      )
        throw Object.assign(
          new Error("Workspace settings changed. Reload before saving."),
          { code: "workspace_policy_conflict" },
        );
      const next = workspaceProfileSchema.parse({ ...current, ...patch });
      await transaction
        .update(workspaces)
        .set({ profile: next })
        .where(eq(workspaces.id, workspaceId));
      return next;
    },
    async usageSummary() {
      scope.assertOpen();
      const catalog = await transaction.execute(
        sql`select to_regclass('public.ai_budget_reservations') as relation`,
      );
      if (!catalog[0]?.relation) return null;
      const rows = await transaction.execute(
        sql`select coalesce(sum(reserved_usd) filter(where state='held'),0)::text held,coalesce(sum(reserved_usd) filter(where state='unknown'),0)::text unknown,coalesce(sum(settled_usd) filter(where state='settled'),0)::text settled,count(*) filter(where state='unknown')::int unknown_runs,(select count(*)::int from ai_runs where workspace_id=${workspaceId} and pipeline_run_id is not null) calls from ai_budget_reservations where workspace_id=${workspaceId}`,
      );
      const row = rows[0]!;
      return {
        heldUsd: String(row.held),
        unknownHeldUsd: String(row.unknown),
        settledUsd: String(row.settled),
        unknownRuns: Number(row.unknown_runs),
        physicalCalls: Number(row.calls),
      };
    },
    async updateProfile(profile) {
      scope.assertOpen();
      const parsed = workspaceProfileSchema.parse(profile);
      const updated = await transaction
        .update(workspaces)
        .set({ profile: parsed })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      if (updated.length !== 1) throw new Error("workspace not found");
    },
  };
}

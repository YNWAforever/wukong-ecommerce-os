import {
  workingBaselineForReview,
  workingFieldStateSchema,
  workingListingSchema,
  type WorkingListing,
  type WorkingFieldStates,
} from "@wukong/core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import type { Listing } from "./listings.js";

export type MaintenanceContentFence = {
  inputRevision: number;
  activeVersionId: string | null;
  sourceBinding: {
    productId: string;
    sourceImportId: string | null;
    rowDigest: string | null;
    updatedAt: string;
  } | null;
};
export const maintenanceContentFenceSchema = z
  .object({
    inputRevision: z.number().int().nonnegative(),
    activeVersionId: z.string().uuid().nullable(),
    sourceBinding: z
      .object({
        productId: z.string().uuid(),
        sourceImportId: z.string().uuid().nullable(),
        rowDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MaintenanceContent = {
  listingId: string;
  status: Listing["status"];
  content: WorkingListing | null;
  assessmentState: "assessed" | "missing" | "invalid";
  fence: MaintenanceContentFence;
  fieldStates?: WorkingFieldStates;
};

/** Content and fences share one SQL observation; SQL faults remain failures. */
export function createMaintenanceContentReader(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  async function load(input: {
    afterId?: string;
    ids?: readonly string[];
    limit: number;
  }): Promise<MaintenanceContent[]> {
    scope.assertOpen();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error("maintenance page limit must be between 1 and 100");
    if (input.afterId && !z.uuid().safeParse(input.afterId).success)
      throw new Error("invalid maintenance cursor");
    if (input.ids?.some((id) => !z.uuid().safeParse(id).success))
      throw new Error("invalid maintenance identity");
    const match = input.ids
      ? sql`d.id in (${sql.join(
          input.ids.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})`
      : input.afterId
        ? sql`d.id > ${input.afterId}::uuid`
        : sql`true`;
    const rows = await tx.execute(sql`
      select d.id,d.status,d.input_revision,d.active_version_id,
        i.id input_id,i.working_content,i.field_states,v.id version_id,v.content version_content,
        p.id product_id,p.source_import_id,p.content_digest,p.updated_at binding_updated_at
      from listing_drafts d
      left join listing_input_revisions i on i.workspace_id=${workspaceId} and i.listing_id=d.id and i.revision=d.input_revision
      left join listing_versions v on v.workspace_id=${workspaceId} and v.listing_id=d.id and v.id=d.active_version_id
      left join lateral (
        select id,source_import_id,content_digest,updated_at from platform_products
        where workspace_id=${workspaceId} and listing_id=d.id
        order by updated_at desc,id desc limit 1
      ) p on true
      where d.workspace_id=${workspaceId} and ${match}
      order by d.id limit ${input.limit}
    `);
    return rows.map((row) => {
      const hasInput = Number(row.input_revision) > 0;
      const parsed = workingListingSchema.safeParse(
        hasInput ? row.working_content : row.version_content,
      );
      const states = z
        .record(z.string(), workingFieldStateSchema)
        .safeParse(hasInput ? row.field_states : {});
      const active = row.active_version_id
        ? workingListingSchema.safeParse(row.version_content)
        : null;
      const valid =
        parsed.success && states.success && (!active || active.success);
      const assessmentState =
        hasInput || row.active_version_id
          ? valid
            ? "assessed"
            : "invalid"
          : "missing";
      const content = valid
        ? hasInput && active?.success
          ? workingBaselineForReview(
              parsed.data,
              states.data as WorkingFieldStates,
              active.data,
            ).workingContent
          : parsed.data
        : null;
      return {
        listingId: String(row.id),
        status: row.status as Listing["status"],
        content,
        assessmentState,
        fence: {
          inputRevision: Number(row.input_revision),
          activeVersionId: row.active_version_id as string | null,
          sourceBinding: row.product_id
            ? {
                productId: String(row.product_id),
                sourceImportId: row.source_import_id as string | null,
                rowDigest: row.content_digest as string | null,
                updatedAt: new Date(
                  row.binding_updated_at as string,
                ).toISOString(),
              }
            : null,
        },
      };
    });
  }
  return {
    async lockMaintenanceListings(ids: readonly string[]) {
      scope.assertOpen();
      if (!ids.length) return;
      if (ids.length > 100 || ids.some((id) => !z.uuid().safeParse(id).success))
        throw new Error("invalid maintenance lock identities");
      await tx.execute(
        sql`select id from listing_drafts where workspace_id=${workspaceId} and id in (${sql.join(
          [...new Set(ids)].sort().map((id) => sql`${id}::uuid`),
          sql`,`,
        )}) order by id for update`,
      );
    },
    async lockMaintenanceBindings(ids: readonly string[]) {
      scope.assertOpen();
      if (!ids.length) return;
      if (ids.length > 100 || ids.some((id) => !z.uuid().safeParse(id).success))
        throw new Error("invalid maintenance lock identities");
      await tx.execute(
        sql`select id from platform_products where workspace_id=${workspaceId} and listing_id in (${sql.join(
          [...new Set(ids)].sort().map((id) => sql`${id}::uuid`),
          sql`,`,
        )}) order by id for update`,
      );
    },
    scanMaintenancePage(afterId?: string, limit = 100) {
      return load({ afterId, limit });
    },
    getMaintenanceByIds(ids: readonly string[]) {
      scope.assertOpen();
      if (!ids.length) return Promise.resolve([]);
      if (ids.length > 100)
        throw new Error("maintenance hydration exceeds page size");
      return load({ ids: [...new Set(ids)], limit: 100 });
    },
  };
}

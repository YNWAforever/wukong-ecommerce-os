import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  prepareWorkbookBase,
  hashBulkFormHeaderContract,
  type PreparedWorkbookBase,
  type WorkbookBaseProduct,
  type InferredWorkbookTime,
} from "@wukong/shopline";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { memberships, workbookImports, workbookProducts } from "../schema.js";
import { createAuditWriter } from "./audit.js";

export type WorkbookSaveInput = {
  filename: string;
  workbookSha256: string;
  headerContractSha256: string;
  sheetName: string;
  prepared: PreparedWorkbookBase;
  actorId: string;
};
export type WorkbookSaveResult = {
  importId: string;
  importedProducts: number;
  alreadyImportedProducts: number;
  excludedRows: number;
};
export type WorkbookCatalogProduct = {
  id: string;
  sourceType: "workbook";
  product: WorkbookBaseProduct;
  source: {
    id: string;
    filename: string;
    sheetName: string;
    inferredExportTime: InferredWorkbookTime | null;
    createdAt: Date;
  };
  canExport: false;
};
export type WorkbookCatalogRepository = {
  save(input: WorkbookSaveInput): Promise<WorkbookSaveResult>;
  getProduct(id: string): Promise<WorkbookCatalogProduct | null>;
};
export function createWorkbookCatalogRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkbookCatalogRepository {
  const audit = createAuditWriter(transaction, workspaceId, scope);
  return {
    async save(input) {
      scope.assertOpen();
      const [member] = await transaction
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, input.actorId),
          ),
        )
        .for("share");
      if (
        !member ||
        !["operator", "reviewer", "admin", "owner"].includes(member.role)
      )
        throw new Error("Workbook catalog requires operator role");
      z.string()
        .min(6)
        .max(255)
        .regex(/\.xlsx$/i)
        .parse(input.filename);
      z.string().min(1).max(255).parse(input.sheetName);
      z.string()
        .regex(/^[0-9a-f]{64}$/)
        .parse(input.workbookSha256);
      if (input.headerContractSha256 !== hashBulkFormHeaderContract())
        throw new Error("Workbook header contract mismatch");
      const sheet = z
        .array(z.array(z.string().nullable()))
        .parse(input.prepared.sheet);
      if (Buffer.byteLength(JSON.stringify(sheet)) > 16 * 1024 * 1024)
        throw new Error("Workbook source exceeds 16 MiB");
      const prepared = prepareWorkbookBase(sheet, input.filename);
      if (!isDeepStrictEqual(prepared, input.prepared))
        throw new Error("Workbook prepared evidence mismatch");
      if (prepared.totalRows > 5000 || !prepared.products.length)
        throw new Error("Workbook requires 1..5000 eligible products");
      for (const product of prepared.products)
        if (Buffer.byteLength(JSON.stringify(product)) > 1024 * 1024)
          throw new Error("Workbook product exceeds 1 MiB");
      const [created] = await transaction
        .insert(workbookImports)
        .values({
          workspaceId,
          workbookSha256: input.workbookSha256,
          filename: input.filename,
          sheetName: input.sheetName,
          headerContractSha256: input.headerContractSha256,
          normalizedSheet: sheet,
          productBindings: sql`(select jsonb_object_agg(p->>'rowNumber',encode(sha256(convert_to(p::text,'UTF8')),'hex')) from jsonb_array_elements(${JSON.stringify(prepared.products)}::jsonb) p)`,
          specVersion: prepared.specVersion,
          inferredExportTime: prepared.inferredExportTime,
          totalRows: prepared.totalRows,
          eligibleProducts: prepared.products.length,
          excludedRows: prepared.excludedRows,
          actorId: input.actorId,
        })
        .onConflictDoNothing({
          target: [workbookImports.workspaceId, workbookImports.workbookSha256],
        })
        .returning();
      if (!created) {
        const [existing] = await transaction
          .select()
          .from(workbookImports)
          .where(
            and(
              eq(workbookImports.workspaceId, workspaceId),
              eq(workbookImports.workbookSha256, input.workbookSha256),
            ),
          );
        if (!existing) throw new Error("Workbook replay unavailable");
        return {
          importId: existing.id,
          importedProducts: 0,
          alreadyImportedProducts: existing.eligibleProducts,
          excludedRows: existing.excludedRows,
        };
      }
      // Bounded batches avoid both per-row network trips and the PostgreSQL parameter limit.
      for (let offset = 0; offset < prepared.products.length; offset += 100) {
        await transaction.insert(workbookProducts).values(
          prepared.products.slice(offset, offset + 100).map((product) => ({
            workspaceId,
            importId: created.id,
            rowNumber: product.rowNumber,
            product,
          })),
        );
      }
      await audit.write({
        workspaceId,
        actorId: input.actorId,
        entityId: created.id,
        action: "workbook.imported",
        metadata: {
          importedProducts: prepared.products.length,
          excludedRows: prepared.excludedRows,
          totalRows: prepared.totalRows,
        },
      });
      return {
        importId: created.id,
        importedProducts: prepared.products.length,
        alreadyImportedProducts: 0,
        excludedRows: prepared.excludedRows,
      };
    },
    async getProduct(id) {
      scope.assertOpen();
      z.uuid().parse(id);
      const [row] = await transaction
        .select({
          id: workbookProducts.id,
          product: workbookProducts.product,
          source: {
            id: workbookImports.id,
            filename: workbookImports.filename,
            sheetName: workbookImports.sheetName,
            inferredExportTime: workbookImports.inferredExportTime,
            createdAt: workbookImports.createdAt,
          },
        })
        .from(workbookProducts)
        .innerJoin(
          workbookImports,
          and(
            eq(workbookImports.workspaceId, workbookProducts.workspaceId),
            eq(workbookImports.id, workbookProducts.importId),
          ),
        )
        .where(
          and(
            eq(workbookProducts.workspaceId, workspaceId),
            eq(workbookProducts.id, id),
          ),
        );
      if (!row) return null;
      return {
        id: row.id,
        sourceType: "workbook",
        product: row.product,
        source: {
          id: row.source.id,
          filename: row.source.filename,
          sheetName: row.source.sheetName,
          inferredExportTime: row.source.inferredExportTime,
          createdAt: row.source.createdAt,
        },
        canExport: false,
      };
    },
  };
}

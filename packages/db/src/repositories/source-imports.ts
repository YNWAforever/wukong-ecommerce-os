import { and, eq } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { sourceImports } from "../schema.js";

export type CreateSourceImportInput = {
  connectionId: string;
  filename: string;
  workbookSha256: string;
  headerContractSha256: string;
  sheetName: string;
  rowCount: number;
  merchantAttestedExportAt: Date;
  importerId: string;
  specVersion: string;
};

export type SourceImport = {
  id: string;
  connectionId: string;
  filename: string;
  workbookSha256: string;
  headerContractSha256: string;
  sheetName: string;
  rowCount: number;
  merchantAttestedExportAt: Date;
  importerId: string;
  specVersion: string;
  createdAt: Date;
};

export type SourceImportRepository = {
  create(input: CreateSourceImportInput): Promise<SourceImport>;
  getById(id: string): Promise<SourceImport | null>;
};

const COLUMNS = {
  id: sourceImports.id,
  connectionId: sourceImports.connectionId,
  filename: sourceImports.filename,
  workbookSha256: sourceImports.workbookSha256,
  headerContractSha256: sourceImports.headerContractSha256,
  sheetName: sourceImports.sheetName,
  rowCount: sourceImports.rowCount,
  merchantAttestedExportAt: sourceImports.merchantAttestedExportAt,
  importerId: sourceImports.importerId,
  specVersion: sourceImports.specVersion,
  createdAt: sourceImports.createdAt,
};

export function createSourceImportRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): SourceImportRepository {
  return {
    async create(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(sourceImports)
        .values({ ...input, workspaceId })
        .returning(COLUMNS);
      if (!row) throw new Error("source import insert did not return a row");
      return row;
    },

    async getById(id) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(sourceImports)
        .where(
          and(
            eq(sourceImports.workspaceId, workspaceId),
            eq(sourceImports.id, id),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}

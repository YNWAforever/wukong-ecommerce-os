import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createAuditWriter, type WorkspaceAuditWriter } from "./repositories/audit.js";
import { createListingRepository, type ListingRepository } from "./repositories/listings.js";
import { createPipelineRunRepository, type PipelineRunRepository } from "./repositories/pipeline-runs.js";
import { createAiRunRepository, type AiRunRepository } from "./repositories/ai-runs.js";
import { createWorkspaceRepository, type WorkspaceRepository } from "./repositories/workspaces.js";
import {
  createSourceAssetRepository,
  type SourceAssetRepository,
} from "./repositories/source-assets.js";
import * as schema from "./schema.js";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
export type WorkspaceTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];

export type WorkspaceScope = {
  assertOpen(): void;
};

export type WorkspaceRepositories = {
  listings: ListingRepository;
  sourceAssets: SourceAssetRepository;
  pipelineRuns: PipelineRunRepository;
  aiRuns: AiRunRepository;
  workspaces: WorkspaceRepository;
  audit: WorkspaceAuditWriter;
};

export type DatabaseOptions = {
  migrationUrl?: string;
  maxConnections?: number;
};

export type Database = {
  migrate(): Promise<void>;
  forWorkspace<T>(
    workspaceId: string,
    work: (repositories: WorkspaceRepositories) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
};

const ignoreNotice = (): void => undefined;

export function createDatabase(
  url: string,
  options: DatabaseOptions = {},
): Database {
  if (!url) {
    throw new Error("database URL is required");
  }

  const client = postgres(url, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: options.maxConnections ?? 10,
    max_lifetime: 60 * 30,
    onnotice: ignoreNotice,
    prepare: false,
  });
  const drizzleClient = drizzle(client, { schema });

  const runForWorkspace = async <T>(
    workspaceId: string,
    work: (repositories: WorkspaceRepositories) => Promise<T>,
  ): Promise<T> => {
    if (workspaceId.trim().length === 0) {
      throw new Error("workspaceId must not be empty");
    }

    return drizzleClient.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
      );
      let closed = false;
      const scope: WorkspaceScope = {
        assertOpen() {
          if (closed) {
            throw new Error("workspace scope is closed");
          }
        },
      };
      const repositories: WorkspaceRepositories = {
        listings: createListingRepository(transaction, workspaceId, scope),
        sourceAssets: createSourceAssetRepository(transaction, workspaceId, scope),
        pipelineRuns: createPipelineRunRepository(transaction, workspaceId, scope),
        aiRuns: createAiRunRepository(transaction, workspaceId, scope),
        workspaces: createWorkspaceRepository(transaction, workspaceId, scope),
        audit: createAuditWriter(transaction, workspaceId, scope),
      };
      try {
        return await work(repositories);
      } finally {
        closed = true;
      }
    });
  };

  return {
    async migrate() {
      if (!options.migrationUrl) {
        throw new Error("migrationUrl is required for migrations");
      }
      const admin = postgres(options.migrationUrl, {
        connect_timeout: 10,
        max: 1,
        onnotice: ignoreNotice,
        prepare: false,
      });
      try {
        const migrationPath = fileURLToPath(
          new URL("../drizzle/0000_initial.sql", import.meta.url),
        );
        const migration = await readFile(migrationPath, "utf8");
        await admin.begin(async (transaction) => {
          await transaction.unsafe(migration);
        });
      } finally {
        await admin.end();
      }
    },
    forWorkspace: runForWorkspace,
    async close() {
      await client.end();
    },
  };
}

export async function forWorkspace<T>(
  database: Database,
  workspaceId: string,
  work: (repositories: WorkspaceRepositories) => Promise<T>,
): Promise<T> {
  return database.forWorkspace(workspaceId, work);
}
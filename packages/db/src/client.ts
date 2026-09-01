import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAuditWriter,
  type WorkspaceAuditWriter,
} from "./repositories/audit.js";
import {
  createListingRepository,
  type ListingRepository,
} from "./repositories/listings.js";
import {
  createPipelineRunRepository,
  type PipelineRunRepository,
} from "./repositories/pipeline-runs.js";
import {
  createAiRunRepository,
  type AiRunRepository,
} from "./repositories/ai-runs.js";
import {
  createWorkspaceRepository,
  type WorkspaceRepository,
} from "./repositories/workspaces.js";
import {
  createSourceAssetRepository,
  type SourceAssetRepository,
} from "./repositories/source-assets.js";
import {
  createPublishJobRepository,
  type PublishJobRepository,
} from "./repositories/publish-jobs.js";
import {
  createShoplineConnectionRepository,
  type ShoplineConnectionRepository,
} from "./repositories/shopline-connections.js";
import {
  createPlatformProductRepository,
  type PlatformProductRepository,
} from "./repositories/platform-products.js";
import {
  createSourceImportRepository,
  type SourceImportRepository,
} from "./repositories/source-imports.js";
import {
  createEnrichmentBatchRepository,
  type EnrichmentBatchRepository,
} from "./repositories/enrichment-batches.js";
import {
  createMembershipRepository,
  type MembershipRepository,
} from "./repositories/memberships.js";
import {
  createReviewConfirmationRepository,
  type ReviewConfirmationRepository,
} from "./repositories/review-confirmations.js";
import { loadSqlMigrations } from "./migrations.js";
import * as schema from "./schema.js";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
export type AuthDatabase = DrizzleClient;
export type WorkspaceTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];

export type WorkspaceScope = {
  assertOpen(): void;
};

export type WorkspaceRepositories = {
  listings: ListingRepository;
  sourceAssets: SourceAssetRepository;
  publishJobs: PublishJobRepository;
  shoplineConnections: ShoplineConnectionRepository;
  platformProducts: PlatformProductRepository;
  sourceImports: SourceImportRepository;
  reviewConfirmations: ReviewConfirmationRepository;
  enrichmentBatches: EnrichmentBatchRepository;
  pipelineRuns: PipelineRunRepository;
  aiRuns: AiRunRepository;
  workspaces: WorkspaceRepository;
  memberships: MembershipRepository;
  audit: WorkspaceAuditWriter;
};

export type DatabaseOptions = {
  migrationUrl?: string;
  maxConnections?: number;
  /** Injected by tests; production uses the real postgres driver. */
  createClient?: typeof postgres;
};

export type Database = {
  migrate(): Promise<void>;
  ping(): Promise<void>;
  /**
   * Cross-workspace read used only by the Worker's cron sweeper. Deliberately
   * not forWorkspace: wukong_app cannot enumerate tenants, so this calls a
   * SECURITY DEFINER function (0007_stuck_listing_sweeper.sql) instead.
   */
  findStuckListingJobs(input: {
    olderThanSeconds: number;
    maxRows: number;
  }): Promise<
    Array<{
      workspaceId: string;
      draftId: string;
      activeVersionSequence: number;
    }>
  >;
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

  const client = (options.createClient ?? postgres)(url, {
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
        sourceAssets: createSourceAssetRepository(
          transaction,
          workspaceId,
          scope,
        ),
        publishJobs: createPublishJobRepository(
          transaction,
          workspaceId,
          scope,
        ),
        shoplineConnections: createShoplineConnectionRepository(
          transaction,
          workspaceId,
          scope,
        ),
        platformProducts: createPlatformProductRepository(
          transaction,
          workspaceId,
          scope,
        ),
        sourceImports: createSourceImportRepository(
          transaction,
          workspaceId,
          scope,
        ),
        reviewConfirmations: createReviewConfirmationRepository(
          transaction,
          workspaceId,
          scope,
        ),
        enrichmentBatches: createEnrichmentBatchRepository(
          transaction,
          workspaceId,
          scope,
        ),
        pipelineRuns: createPipelineRunRepository(
          transaction,
          workspaceId,
          scope,
        ),
        aiRuns: createAiRunRepository(transaction, workspaceId, scope),
        workspaces: createWorkspaceRepository(transaction, workspaceId, scope),
        memberships: createMembershipRepository(
          transaction,
          workspaceId,
          scope,
        ),
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
        const defaultMigrationsDir = process
          .cwd()
          .endsWith(`${sep}packages${sep}db`)
          ? join(process.cwd(), "drizzle")
          : join(process.cwd(), "packages/db/drizzle");
        const migrations = await loadSqlMigrations(
          pathToFileURL(
            `${process.env.DATABASE_MIGRATIONS_DIR ?? defaultMigrationsDir}${sep}`,
          ),
        );
        for (const migration of migrations) {
          await admin.begin(async (transaction) => {
            await transaction.unsafe(migration.sql);
          });
        }
      } finally {
        await admin.end();
      }
    },
    async ping() {
      // Deliberately not forWorkspace: this proves the connection answers, and
      // must not open a tenant transaction or set a workspace GUC.
      await client`select 1`;
    },
    async findStuckListingJobs({ olderThanSeconds, maxRows }) {
      const rows = await client`
        select workspace_id, draft_id, active_version_sequence
        from sweeper_find_stuck_listing_jobs(${olderThanSeconds}, ${maxRows})
      `;
      return rows.map((row) => ({
        workspaceId: String(row.workspace_id),
        draftId: String(row.draft_id),
        activeVersionSequence: Number(row.active_version_sequence),
      }));
    },
    forWorkspace: runForWorkspace,
    async close() {
      await client.end();
    },
  };
}

/**
 * Creates the unscoped database handle used only by Auth.js and provisioning.
 * Tenant application queries must continue through `createDatabase().forWorkspace`.
 */
export function createAuthDatabase(
  url: string,
): AuthDatabase & { close(): Promise<void> } {
  if (!url) throw new Error("database URL is required");
  const client = postgres(url, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 4,
    max_lifetime: 60 * 30,
    onnotice: ignoreNotice,
    prepare: false,
  });
  const authDb = drizzle(client, { schema });
  return Object.assign(authDb, { close: () => client.end() });
}

export async function forWorkspace<T>(
  database: Database,
  workspaceId: string,
  work: (repositories: WorkspaceRepositories) => Promise<T>,
): Promise<T> {
  return database.forWorkspace(workspaceId, work);
}

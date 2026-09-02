import { describe, expect, it } from "vitest";

import { createJobsHandler } from "./route.js";

describe("GET /api/jobs", () => {
  it("requires an authenticated workspace session", async () => {
    const handler = createJobsHandler({
      sessionContext: {
        async resolve() {
          return null;
        },
      },
      getDatabase: () => {
        throw new Error("database should not be opened");
      },
    });

    const response = await handler();

    expect(response.status).toBe(401);
  });

  it("merges all 4 sources into one ledger for any authenticated member, including a viewer", async () => {
    const calls: unknown[] = [];
    const handler = createJobsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "viewer",
          };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            calls.push(["forWorkspace", workspaceId]);
            return work({
              enrichmentBatches: {
                async listForWorkspace(limit: number) {
                  calls.push(["enrichmentBatches.listForWorkspace", limit]);
                  return [
                    {
                      id: "b1",
                      label: "Batch 1",
                      budgetUsd: 5,
                      waveSize: 3,
                      status: "open",
                      createdBy: "user_1",
                      createdAt: new Date("2026-08-01T00:00:00Z"),
                    },
                  ];
                },
              },
              publishJobs: {
                async listForWorkspace(limit: number) {
                  calls.push(["publishJobs.listForWorkspace", limit]);
                  return [
                    {
                      id: "p1",
                      listingId: "l1",
                      versionId: "v1",
                      connectionId: "c1",
                      status: "published",
                      idempotencyKey: "k1",
                      payloadDigest: null,
                      remoteProductId: "r1",
                      error: null,
                      leaseToken: null,
                      leaseExpiresAt: null,
                      attemptCount: 1,
                      createdAt: new Date("2026-08-02T00:00:00Z"),
                    },
                  ];
                },
              },
              pipelineRuns: {
                async listForWorkspace(limit: number) {
                  calls.push(["pipelineRuns.listForWorkspace", limit]);
                  return [
                    {
                      id: "pr1",
                      listingId: "l2",
                      versionId: null,
                      status: "started",
                      errorCode: null,
                      createdAt: new Date("2026-08-03T00:00:00Z"),
                    },
                  ];
                },
              },
              exportAttempts: {
                async listForWorkspace(limit: number) {
                  calls.push(["exportAttempts.listForWorkspace", limit]);
                  return [
                    {
                      id: "e1",
                      requestedBy: "user_1",
                      manifest: [
                        {
                          listingId: "l3",
                          versionId: "v3",
                          outcome: "included",
                        },
                      ],
                      rowCount: 1,
                      specVersion: "opak-2026-05",
                      createdAt: new Date("2026-08-04T00:00:00Z"),
                    },
                  ];
                },
              },
              audit: {
                async countByActionSince() {
                  return 0;
                },
                async countByActionAndMetadataKeySince() {
                  return [];
                },
                async sumImportMetricsSince() {
                  return {
                    parsedRows: 0,
                    createdDrafts: 0,
                    refreshedProducts: 0,
                    issueCount: 0,
                  };
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();

    expect(response.status).toBe(200);
    const body = await response.json();
    // Newest-first: e1 (08-04) > pr1 (08-03) > p1 (08-02) > b1 (08-01).
    expect(body.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "e1",
      "pr1",
      "p1",
      "b1",
    ]);
    expect(body.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
      "export",
      "pipeline_run",
      "publish_job",
      "batch",
    ]);

    expect(calls).toEqual([
      ["forWorkspace", "ws_opak"],
      ["enrichmentBatches.listForWorkspace", 100],
      ["publishJobs.listForWorkspace", 100],
      ["pipelineRuns.listForWorkspace", 100],
      ["exportAttempts.listForWorkspace", 100],
    ]);
  });

  it("includes a metrics summary alongside the ledger entries", async () => {
    const handler = createJobsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "viewer",
          };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async listForWorkspace() {
                  return [];
                },
              },
              publishJobs: {
                async listForWorkspace() {
                  return [];
                },
              },
              pipelineRuns: {
                async listForWorkspace() {
                  return [];
                },
              },
              exportAttempts: {
                async listForWorkspace() {
                  return [];
                },
              },
              audit: {
                async countByActionSince() {
                  return 3;
                },
                async countByActionAndMetadataKeySince() {
                  return [
                    { value: "version_conflict", count: 1 },
                    { value: "source_import_mismatch", count: 2 },
                  ];
                },
                async sumImportMetricsSince() {
                  return {
                    parsedRows: 120,
                    createdDrafts: 10,
                    refreshedProducts: 5,
                    issueCount: 2,
                  };
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();
    const body = await response.json();
    expect(body.metrics).toEqual({
      publishRetries: expect.any(Number),
      versionConflicts: expect.any(Number),
      staleSourceRejections: expect.any(Number),
      importedRows: expect.any(Number),
    });
  });
});

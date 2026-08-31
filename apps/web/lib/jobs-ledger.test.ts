import type { PipelineRunSummary, PublishJob } from "@wukong/db";
import { describe, expect, it } from "vitest";

import { buildJobsLedger } from "./jobs-ledger.js";

describe("buildJobsLedger", () => {
  it("normalizes each source's status and merges/sorts by createdAt descending", () => {
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "Batch 1",
            budgetUsd: 5,
            waveSize: 3,
            status: "open",
            createdBy: "u1",
            createdAt: new Date("2026-08-31T10:00:00Z"),
          },
          {
            id: "b2",
            label: "Batch 2",
            budgetUsd: 5,
            waveSize: 3,
            status: "budget_exhausted",
            createdBy: "u1",
            createdAt: new Date("2026-08-31T08:00:00Z"),
          },
        ],
        publishJobs: [
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
            createdAt: new Date("2026-08-31T09:00:00Z"),
          },
        ],
        pipelineRuns: [
          {
            id: "pr1",
            listingId: "l2",
            versionId: null,
            status: "started",
            errorCode: null,
            createdAt: new Date("2026-08-31T11:00:00Z"),
          },
        ],
        exports: [
          {
            id: "e1",
            requestedBy: "u1",
            manifest: [
              { listingId: "l3", versionId: "v3", outcome: "included" },
            ],
            rowCount: 1,
            specVersion: "opak-2026-05",
            createdAt: new Date("2026-08-31T07:00:00Z"),
          },
        ],
      },
      10,
    );

    expect(entries.map((e) => e.id)).toEqual(["pr1", "b1", "p1", "b2", "e1"]);
    expect(entries[0]).toMatchObject({
      kind: "pipeline_run",
      normalizedStatus: "running",
      rawStatus: "started",
      listingId: "l2",
    });
    expect(entries[1]).toMatchObject({
      kind: "batch",
      normalizedStatus: "pending",
      rawStatus: "open",
      listingId: null,
    });
    expect(entries[2]).toMatchObject({
      kind: "publish_job",
      normalizedStatus: "succeeded",
      rawStatus: "published",
      listingId: "l1",
    });
    expect(entries[3]).toMatchObject({
      kind: "batch",
      normalizedStatus: "cancelled",
      rawStatus: "budget_exhausted",
      listingId: null,
    });
    expect(entries[4]).toMatchObject({
      kind: "export",
      normalizedStatus: "succeeded",
      rawStatus: "export_attempts",
      listingId: null,
    });
  });

  it("truncates to limit after merging, not per-source", () => {
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "A",
            budgetUsd: 1,
            waveSize: 1,
            status: "open",
            createdBy: "u",
            createdAt: new Date("2026-08-31T12:00:00Z"),
          },
          {
            id: "b2",
            label: "B",
            budgetUsd: 1,
            waveSize: 1,
            status: "open",
            createdBy: "u",
            createdAt: new Date("2026-08-31T11:00:00Z"),
          },
        ],
        publishJobs: [],
        pipelineRuns: [],
        exports: [],
      },
      1,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("b1");
  });

  it("produces the correct summary and null listingId for each kind", () => {
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "My batch",
            budgetUsd: 5,
            waveSize: 3,
            status: "completed",
            createdBy: "u",
            createdAt: new Date(),
          },
        ],
        publishJobs: [],
        pipelineRuns: [],
        exports: [
          {
            id: "e1",
            requestedBy: "u",
            manifest: [
              { listingId: "l1", versionId: "v1", outcome: "included" },
              {
                listingId: "l2",
                versionId: null,
                outcome: "listing_not_found",
              },
            ],
            rowCount: 1,
            specVersion: "opak-2026-05",
            createdAt: new Date(),
          },
        ],
      },
      10,
    );
    const batch = entries.find((e) => e.kind === "batch");
    const exportEntry = entries.find((e) => e.kind === "export");
    expect(batch?.listingId).toBeNull();
    expect(batch?.summary).toContain("My batch");
    expect(exportEntry?.listingId).toBeNull();
    expect(exportEntry?.summary).toMatch(/1.*row/i);
  });

  it("breaks a createdAt tie by descending id, matching Task 1's listForWorkspace convention", () => {
    const tiedCreatedAt = new Date("2026-08-31T10:00:00Z");
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "A",
            budgetUsd: 1,
            waveSize: 1,
            status: "open",
            createdBy: "u",
            createdAt: tiedCreatedAt,
          },
          {
            id: "b2",
            label: "B",
            budgetUsd: 1,
            waveSize: 1,
            status: "open",
            createdBy: "u",
            createdAt: tiedCreatedAt,
          },
        ],
        publishJobs: [],
        pipelineRuns: [],
        exports: [],
      },
      10,
    );
    // desc(createdAt), desc(id): same timestamp, so "b2" (the greater id)
    // sorts first.
    expect(entries.map((e) => e.id)).toEqual(["b2", "b1"]);
  });

  it("falls back to a 'failed' normalizedStatus for a publish job or pipeline run status outside the known union", () => {
    const entries = buildJobsLedger(
      {
        batches: [],
        publishJobs: [
          {
            id: "p1",
            listingId: "l1",
            versionId: "v1",
            connectionId: "c1",
            // Simulates a row holding a value the TS union doesn't cover --
            // the repository layer only narrows this via an `as` cast over a
            // plain `text()` column, so this is reachable at runtime.
            status: "archived" as unknown as PublishJob["status"],
            idempotencyKey: "k1",
            payloadDigest: null,
            remoteProductId: null,
            error: null,
            leaseToken: null,
            leaseExpiresAt: null,
            attemptCount: 1,
            createdAt: new Date("2026-08-31T10:00:00Z"),
          },
        ],
        pipelineRuns: [
          {
            id: "pr1",
            listingId: "l2",
            versionId: null,
            status: "archived" as unknown as PipelineRunSummary["status"],
            errorCode: null,
            createdAt: new Date("2026-08-31T09:00:00Z"),
          },
        ],
        exports: [],
      },
      10,
    );
    const publishJobEntry = entries.find((e) => e.kind === "publish_job");
    const pipelineRunEntry = entries.find((e) => e.kind === "pipeline_run");
    expect(publishJobEntry?.normalizedStatus).toBe("failed");
    expect(pipelineRunEntry?.normalizedStatus).toBe("failed");
    // The summary text must agree with normalizedStatus's "failed" framing --
    // not just be a distinct, contradictory "we don't know" message.
    expect(publishJobEntry?.summary).toContain("treated as failed");
  });

  it("summarizes a pending_enqueue/queued publish job as queued, not as actively publishing", () => {
    const entries = buildJobsLedger(
      {
        batches: [],
        publishJobs: [
          {
            id: "p1",
            listingId: "l1",
            versionId: "v1",
            connectionId: "c1",
            status: "pending_enqueue",
            idempotencyKey: "k1",
            payloadDigest: null,
            remoteProductId: null,
            error: null,
            leaseToken: null,
            leaseExpiresAt: null,
            attemptCount: 0,
            createdAt: new Date("2026-08-31T10:00:00Z"),
          },
          {
            id: "p2",
            listingId: "l2",
            versionId: "v2",
            connectionId: "c1",
            status: "queued",
            idempotencyKey: "k2",
            payloadDigest: null,
            remoteProductId: null,
            error: null,
            leaseToken: null,
            leaseExpiresAt: null,
            attemptCount: 0,
            createdAt: new Date("2026-08-31T09:00:00Z"),
          },
        ],
        pipelineRuns: [],
        exports: [],
      },
      10,
    );
    for (const entry of entries) {
      expect(entry.summary).not.toBe("Publishing");
      expect(entry.summary).toBe("Queued for publish");
    }
  });
});

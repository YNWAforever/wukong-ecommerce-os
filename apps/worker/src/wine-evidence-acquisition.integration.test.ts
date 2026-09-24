import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, createWineEvidenceStore } from "@wukong/db";
import { wineIdentity } from "@wukong/core";
import { createWineEvidenceAcquisition } from "./wine-evidence-acquisition.js";
const db = createDatabase(process.env.TEST_DATABASE_URL!);
afterAll(() => db.close());
it("acquires through committed real DB ports and reuses captured evidence without another paid call", async () => {
  const workspaceId = `worker-acquisition-${randomUUID()}`;
  const run = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        wineMode: "full",
        wineAcquisition: {
          schemaVersion: 1,
          deadlineAt: new Date(Date.now() + 840000).toISOString(),
          policyVersion: "p1",
          rulesVersion: "r1",
          allowedDomains: ["wine.test"],
        },
      },
    });
    await r.searchBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedCredits: 5,
      workspaceCapCredits: 100,
      policyVersion: "p1",
    });
    return run;
  });
  const input = {
    workspaceId,
    runId: run.id,
    inputRevision: 0,
    policyDigest: "p1",
    rulesVersion: "r1",
    allowedDomains: ["wine.test"],
    identity: wineIdentity(),
    now: new Date().toISOString(),
    forceRefresh: false,
  };
  const search = vi.fn(async () => {
    expect(
      await db.forWorkspace(workspaceId, (r) =>
        r.wineEnrichment.readSearchCall(run.id, "basic_1"),
      ),
    ).toMatchObject({ status: "started" });
    return {
      credits: 1,
      requestId: "synthetic",
      results: [
        {
          url: "https://wine.test/a",
          title: "Wine",
          content: "wine snippet",
          rawContent: null,
        },
      ],
    };
  });
  const ports = {
    store: createWineEvidenceStore(db),
    provider: { search, extract: vi.fn() },
    document: async (request: import("@wukong/jobs").WineDocumentRequest) => {
      const sources = await db.forWorkspace(workspaceId, (r) =>
        r.wineEnrichment.readEvidence(run.id),
      );
      expect(sources.some((s) => s.id === request.sourceId)).toBe(true);
      return {
        ...request,
        schemaVersion: 1 as const,
        state: "ready" as const,
        url: "https://wine.test/a",
        capturedAt: new Date().toISOString(),
        title: "Wine",
        text: "Wine document",
        documentDigest: "sha256:" + "a".repeat(64),
        truncated: false,
        spans: [{ start: 0, end: 13, location: "body:text" }],
        warnings: [],
        extractEligible: true,
      };
    },
  };
  const acquire = createWineEvidenceAcquisition({
    database: db,
    tavilyApiKey: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    queueSecret: "synthetic",
    fetch: async (url, init) => {
      if (String(url) === "https://api.tavily.com/search") {
        const output = await search();
        return Response.json({
          results: output.results,
          request_id: "synthetic",
          usage: { credits: 1 },
        });
      }
      expect(String(url)).toBe(
        "https://callback.test/api/internal/wine-evidence-document",
      );
      return Response.json({
        status: "completed",
        result: await ports.document(JSON.parse(String(init?.body))),
      });
    },
  });
  const first = await acquire(input, { stage: "basic", slots: ["basic_1"] });
  expect(first.status).toBe("complete");
  const second = await acquire(input, { stage: "basic", slots: ["basic_1"] });
  expect(second).toEqual(first);
  expect(search).toHaveBeenCalledTimes(1);
  const evidence = await db.forWorkspace(workspaceId, (r) =>
    r.wineEnrichment.readEvidence(run.id),
  );
  expect(evidence).toHaveLength(2);
  expect(evidence.map((s) => s.contentScope).sort()).toEqual([
    "document",
    "snippet",
  ]);
});

it("exports a real Worker runtime factory that validates its fixed callback origin", async () => {
  const { createWineEvidenceAcquisition } =
    await import("./wine-evidence-acquisition.js");
  expect(() =>
    createWineEvidenceAcquisition({
      database: db,
      tavilyApiKey: "synthetic",
      websiteFetchBaseUrl: "https://callback.test/arbitrary",
      queueSecret: "synthetic",
    }),
  ).toThrow("invalid wine callback configuration");
});

import { expect, it } from "vitest";
import { wineIdentity, webEvidence } from "@wukong/core";
import { wineStageDependencyDigest } from "@wukong/db";
import { readWineProgress } from "./wine-progress";
function fixture(state = "succeeded") {
  const run: any = {
    id: "run",
    listingId: "listing",
    inputRevision: 2,
    baseVersionId: null,
    executionState: state,
    execution: {
      flowVersion: "wine-enrichment-v1",
      wineMode: "full",
      wineInputDigest: "input",
      wineSourceDigest: "sources",
      wineAcquisition: { allowedDomains: ["example.com"] },
    },
  };
  const rows: any[] = [];
  const append = (stage: string, result: any, fresh = true) => {
    const row: any = {
      runId: run.id,
      stage,
      inputDigest: "input",
      dependencyDigest: wineStageDependencyDigest(run, rows),
      updatedAt: "2026-09-20T00:00:00.000Z",
      state: "succeeded",
      output: {
        schemaVersion: 1,
        fresh,
        result: { schemaVersion: 1, stage, state: "succeeded", ...result },
      },
    };
    rows.push(row);
    return row;
  };
  const repos: any = {
    wineEnrichment: {
      readStage: async (_run: string, stage: string) =>
        rows.find((x) => x.stage === stage) ?? null,
      readUsage: async () => ({ goEstimatedUsd: "0.123456", tavilyCredits: 2 }),
    },
  };
  return { run, rows, append, repos };
}
it("does not infer successful completion from succeeded run or elapsed time", async () => {
  const f = fixture();
  const p = await readWineProgress(f.repos, f.run);
  expect(p?.state).toBe("needs_info");
  expect(p?.completedStages).toEqual([]);
  expect(p?.enrichment).toBe("unavailable");
});
it("returns only durable fresh matching checkpoints as completed", async () => {
  const f = fixture("running");
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [],
    issues: [
      { path: "identity", code: "missing", blocking: true, evidenceIds: [] },
    ],
  });
  expect(await readWineProgress(f.repos, f.run)).toMatchObject({
    state: "running",
    completedStages: ["extraction"],
    issues: [{ blocking: true }],
    goEstimatedUsd: "0.123456",
    tavilyCredits: 2,
  });
  f.rows[0].inputDigest = "wrong";
  expect((await readWineProgress(f.repos, f.run))?.completedStages).toEqual([]);
});
it("exposes persisted source IDs with sanitized evidence and no confirmation action", async () => {
  const f = fixture("running");
  const evidence = webEvidence({
    url: "https://example.com/wine?token=private-secret#secret",
    domain: "example.com",
    excerpt: "See https://127.0.0.1/private?secret=hidden",
    identity: wineIdentity(),
  });
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [evidence],
    issues: [],
  });
  const p = await readWineProgress(f.repos, f.run);
  expect(p?.candidates[0]).toMatchObject({
    id: evidence.id,
    stage: "extraction",
    confirmationAvailable: false,
  });
  expect(p?.evidence[0]?.url).toBeNull();
  expect(JSON.stringify(p)).not.toMatch(
    /private-secret|127\.0\.0\.1|hidden|frozen|rawPayload/,
  );
});
it("keeps rejected generation inspectable and never accepted", async () => {
  const f = fixture("failed");
  const content = {
    title: { en: "Safe", "zh-Hant": "安全" },
    seo: {
      title: { en: "Safe", "zh-Hant": "安全" },
      description: { en: "Safe", "zh-Hant": "安全" },
    },
    tags: [],
    sections: [],
  };
  const row = f.append("generation", { content, issues: [] }, false);
  row.output.rejectedResult = row.output.result;
  row.output.result = {
    schemaVersion: 1,
    stage: "generation",
    state: "blocked",
    code: "generation_authorization_changed",
  };
  const p = await readWineProgress(f.repos, f.run);
  expect(p?.completedStages).toEqual([]);
  expect(p?.inspection).toEqual([
    expect.objectContaining({
      stage: "generation",
      status: "rejected",
      content,
    }),
  ]);
  expect(p?.candidates).toEqual([]);
});
it.each(["superseded", "cancelled", "failed"])(
  "retains durable terminal %s independently of content",
  async (state) => {
    const f = fixture(state);
    expect((await readWineProgress(f.repos, f.run))?.state).toBe(state);
  },
);
it("does not expose non-wine execution", async () => {
  const f = fixture();
  delete f.run.execution.flowVersion;
  expect(await readWineProgress(f.repos, f.run)).toBeNull();
});

it.each([
  "https://127.0.0.1/private",
  "https://user:pass@example.com/private",
  "https://example.com/private/secret-path",
  "https://example.com:444/private",
  "http://example.com/private",
  "https://private.internal/path",
])("never returns private link material from %s", async (url) => {
  const f = fixture("running");
  f.run.execution.wineAcquisition.allowedDomains.push(
    "private.internal",
    "127.0.0.1",
  );
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [webEvidence({ url, domain: "example.com" })],
    issues: [],
  });
  const p = await readWineProgress(f.repos, f.run);
  expect(p?.evidence[0]?.url ?? null).toBeNull();
});
it("separates persisted stale output from usable identity and filters source and provider secrets", async () => {
  const f = fixture("superseded");
  const identity = wineIdentity({
    producer: "https://private.internal/source?secret=123",
    productName: "tvly-abcdefgh123456",
  });
  f.append(
    "extraction",
    {
      observedAt: "2026-09-20T00:00:00.000Z",
      identity,
      evidence: [],
      issues: [],
    },
    false,
  );
  expect(await readWineProgress(f.repos, f.run)).toMatchObject({
    state: "superseded",
    identity: null,
    candidates: [],
    completedStages: [],
  });
});
it("keeps the exact public supporting page and safe identity query, exposing content scope", async () => {
  const f = fixture("running");
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [
      webEvidence({
        url: "https://example.com/products/reserve-red?variant=750&utm_source=tracking#details",
        domain: "example.com",
        contentScope: "document",
      }),
    ],
    issues: [],
  });
  expect((await readWineProgress(f.repos, f.run))?.evidence[0]).toMatchObject({
    url: "https://example.com/products/reserve-red?variant=750",
    linkStatus: "available",
    contentScope: "document",
  });
});
it("marks signed source URL unavailable instead of replacing it with publisher homepage", async () => {
  const f = fixture("running");
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [
      webEvidence({
        url: "https://example.com/products/reserve-red?X-Amz-Signature=private-signature",
        domain: "example.com",
      }),
    ],
    issues: [],
  });
  expect((await readWineProgress(f.repos, f.run))?.evidence[0]).toMatchObject({
    url: null,
    linkStatus: "unavailable",
  });
});

it.each([
  "https://example.com/products/wine?sessionId=credential",
  "https://example.com/products/wine?document=unknown",
  "https://example.com/products/wine?id=sk-abcdefgh123456",
])("omits unreviewed or secret query selectors %s", async (url) => {
  const f = fixture("running");
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [webEvidence({ url, domain: "example.com" })],
    issues: [],
  });
  expect((await readWineProgress(f.repos, f.run))?.evidence[0]).toMatchObject({
    url: null,
    linkStatus: "unavailable",
  });
});
it("photo evidence has no public link even with an allowlisted publisher", async () => {
  const f = fixture("running");
  f.append("extraction", {
    observedAt: "2026-09-20T00:00:00.000Z",
    identity: wineIdentity(),
    evidence: [
      webEvidence({
        kind: "photo",
        assetId: "00000000-0000-4000-8000-000000000111",
        url: null,
        domain: null,
        contentScope: "label",
      }),
    ],
    issues: [],
  });
  expect((await readWineProgress(f.repos, f.run))?.evidence[0]).toMatchObject({
    url: null,
    linkStatus: "not_applicable",
    contentScope: "label",
  });
});

import type { WineDocumentRequest, WineDocumentResult } from "@wukong/jobs";
import type { TavilyResponse } from "@wukong/ai";
import { describe, expect, it, vi } from "vitest";
import { wineIdentity, webEvidence } from "@wukong/core";
import type { WineEvidenceStore, SearchCallRecord } from "@wukong/db";
import {
  acquireWineEvidence,
  wineEvidenceCacheKey,
  wineIdentityQueries,
} from "./wine-evidence-acquisition.js";
const now = "2026-09-16T00:00:00.000Z";
const request = {
  workspaceId: "w",
  runId: "00000000-0000-4000-8000-000000000001",
  inputRevision: 0,
  identity: wineIdentity(),
  allowedDomains: ["wine.test"],
  policyDigest: "p1",
  rulesVersion: "r1",
  now,
  forceRefresh: false,
};
function harness() {
  const sources: ReturnType<typeof webEvidence>[] = [],
    calls = new Map<string, SearchCallRecord>();
  const store: WineEvidenceStore = {
    context: async () => ({
      schemaVersion: 1,
      deadlineAt: "2026-09-16T00:14:00.000Z",
      policyVersion: "p1",
      rulesVersion: "r1",
      allowedDomains: ["wine.test"],
      now,
      acceptedAt: now,
    }),
    admit: async (input, call) => {
      const old = calls.get(call.slot);
      if (old)
        return old.status === "succeeded" && old.output
          ? { state: "completed", record: old }
          : { state: "unknown" };
      calls.set(call.slot, {
        ...call,
        runId: input.runId,
        status: "started",
        credits: null,
        output: null,
        diagnostic: null,
        updatedAt: now,
      });
      return { state: "claimed" };
    },
    finish: async (input, call) => {
      calls.set(call.slot, {
        ...call,
        runId: input.runId,
        updatedAt: now,
        status:
          call.status === "succeeded"
            ? "succeeded"
            : call.status === "failed"
              ? "failed"
              : "unknown",
        output: call.output ?? null,
        diagnostic: call.diagnostic ?? null,
      });
      return true;
    },
    authorities: async () => [],
    readEvidence: async () => sources,
    saveEvidence: async (_, next) => {
      for (const source of next)
        if (!sources.some((s) => s.id === source.id)) sources.push(source);
    },
    cache: async () => null,
    saveCache: vi.fn(async (_, key, snapshotId, sourceIds) => ({
      ...key,
      snapshotId,
      runId: request.runId,
      capturedAt: now,
      payload: {
        schemaVersion: 1,
        sources: sources.filter((s) => sourceIds.includes(s.id)),
      },
    })),
  };
  const search = vi.fn(async (): Promise<TavilyResponse> => ({
    credits: 1,
    requestId: null,
    results: [
      {
        url: "https://wine.test/a",
        title: "wine",
        content: "wine text",
        rawContent: null,
      },
    ],
  }));
  const extract = vi.fn(async (): Promise<TavilyResponse> => ({
    credits: 1,
    requestId: null,
    results: [],
  }));
  const document = vi.fn(
    async (input: WineDocumentRequest): Promise<WineDocumentResult> => ({
      ...input,
      schemaVersion: 1 as const,
      state: "ready" as const,
      url: "https://wine.test/a",
      capturedAt: now,
      title: "wine",
      text: "wine body",
      documentDigest: "sha256:" + "a".repeat(64),
      truncated: false,
      spans: [{ start: 0, end: 9, location: "body:text" }],
      warnings: [],
      extractEligible: true,
    }),
  );
  return {
    store,
    provider: { search, extract },
    document,
    now: () => new Date(now),
    sources,
    calls,
  };
}
describe("wine evidence acquisition", () => {
  it("keys full normalized identity, tenant, policy, rules and vintage", () => {
    expect(wineEvidenceCacheKey(request)).toBe(
      wineEvidenceCacheKey({
        ...request,
        identity: wineIdentity({ producer: "  FIXTURE ESTATE " }),
      }),
    );
    for (const changes of [
      { workspaceId: "other" },
      { policyDigest: "p2" },
      { rulesVersion: "r2" },
      { identity: wineIdentity({ vintage: { state: "known", year: 2020 } }) },
    ])
      expect(wineEvidenceCacheKey({ ...request, ...changes })).not.toBe(
        wineEvidenceCacheKey(request),
      );
  });
  it("builds only public typed identity queries and rejects injected URLs", () => {
    expect(
      wineIdentityQueries(
        wineIdentity({
          vintage: { state: "known", year: 2020 },
          volumeMl: 750,
        }),
      )[0],
    ).toContain("2020 750ml");
    expect(() =>
      wineIdentityQueries(
        wineIdentity({ producer: "https://private.test/secret" }),
      ),
    ).toThrow();
    expect(
      wineIdentityQueries(
        wineIdentity({ aliases: ["private note do not send"] }),
      ).join(" "),
    ).not.toContain("private note");
  });
  it("persists snippets before callback, creates new immutable document and replays without paid recall", async () => {
    const h = harness(),
      original = h.document;
    h.document = vi.fn(async (input) => {
      expect(h.sources.some((s) => s.id === input.sourceId)).toBe(true);
      return original(input);
    });
    const first = await acquireWineEvidence(
      request,
      { stage: "basic", slots: ["basic_1"] },
      h,
    );
    const second = await acquireWineEvidence(
      request,
      { stage: "basic", slots: ["basic_1"] },
      h,
    );
    expect(h.provider.search).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.sources[0]?.contentScope).toBe("document");
    expect(h.sources).toHaveLength(2);
    expect(first.sources[0]?.trust).toBe("unverified");
    expect(first.sources[0]?.identity).toBeNull();
  });
  it("deduplicates URLs and filters forbidden domains before callback", async () => {
    const h = harness();
    h.provider.search.mockResolvedValue({
      credits: 1,
      requestId: null,
      results: [
        "https://wine.test/a",
        "https://wine.test/a#fragment",
        "https://private.test/a",
      ].map((url) => ({
        url,
        title: "wine",
        content: "text",
        rawContent: null,
      })),
    });
    const result = await acquireWineEvidence(
      request,
      { stage: "basic", slots: ["basic_1"] },
      h,
    );
    expect(h.document).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(1);
  });
  it("robots denial never permits Extract", async () => {
    const h = harness();
    h.document.mockResolvedValue({
      ...(await h.document({
        ...request,
        sourceId: request.runId,
        kind: "product",
      })),
      state: "denied",
      text: "",
      spans: [],
      extractEligible: false,
    } as never);
    const result = await acquireWineEvidence(
      request,
      { stage: "basic", slots: ["basic_1"] },
      h,
    );
    await acquireWineEvidence(
      request,
      { stage: "extract", sourceIds: result.sources.map((s) => s.id) },
      h,
    );
    expect(h.provider.extract).not.toHaveBeenCalled();
  });
  it("unknown usage stops remaining calls and persists an unknown hold", async () => {
    const h = harness();
    h.provider.search.mockResolvedValue({
      credits: null,
      requestId: null,
      results: [],
    } as never);
    const result = await acquireWineEvidence(
      request,
      { stage: "basic", slots: ["basic_1", "basic_2"] },
      h,
    );
    expect(h.provider.search).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain("outcome_unknown");
    expect(h.calls.get("basic_1")?.status).toBe("unknown");
  });
  it.each([7 * 86400000, 8 * 86400000, -1000])(
    "rejects expired/future cache source age %s",
    async (age) => {
      const h = harness(),
        source = webEvidence({
          url: "https://wine.test/a",
          domain: "wine.test",
          capturedAt: new Date(Date.parse(now) - age).toISOString(),
        });
      h.store.cache = async (_, key) => ({
        ...key,
        snapshotId: request.runId,
        runId: "previous-run",
        capturedAt: source.capturedAt,
        payload: { schemaVersion: 1, sources: [source] },
      });
      await acquireWineEvidence(
        request,
        { stage: "basic", slots: ["basic_1"] },
        h,
      );
      expect(h.provider.search).toHaveBeenCalledTimes(1);
    },
  );
  it("cache preserves capture/provenance and rechecks authority", async () => {
    const h = harness(),
      source = webEvidence({
        url: "https://wine.test/a",
        domain: "wine.test",
        capturedAt: now,
        trust: "verified_official",
      });
    h.store.cache = async (_, key) => ({
      ...key,
      snapshotId: request.runId,
      runId: "previous-run",
      capturedAt: now,
      payload: { schemaVersion: 1, sources: [source] },
    });
    const result = await acquireWineEvidence(
      request,
      { stage: "basic", slots: ["basic_1"] },
      h,
    );
    expect(result.sources).toEqual([{ ...source, trust: "unverified" }]);
    expect(h.provider.search).not.toHaveBeenCalled();
    expect(h.store.saveCache).not.toHaveBeenCalled();
  });
});

it("groups cloned document content under one independence key", async () => {
  const h = harness();
  h.provider.search.mockResolvedValue({
    credits: 1,
    requestId: null,
    results: ["https://wine.test/a", "https://wine.test/b"].map((url) => ({
      url,
      title: "Wine",
      content: "same",
      rawContent: null,
    })),
  });
  const result = await acquireWineEvidence(
    request,
    { stage: "basic", slots: ["basic_1"] },
    h,
  );
  expect(result.sources).toHaveLength(2);
  expect(new Set(result.sources.map((s) => s.independenceKey)).size).toBe(1);
});
it("retains snippet truncation and never sends snippet instructions into next query", async () => {
  const h = harness();
  h.document.mockRejectedValue(new Error("refused"));
  h.provider.search.mockResolvedValue({
    credits: 1,
    requestId: null,
    results: [
      {
        url: "https://wine.test/a",
        title: "Wine",
        content: "x".repeat(16001),
        rawContent: null,
      },
    ],
  });
  const result = await acquireWineEvidence(
    request,
    { stage: "basic", slots: ["basic_1", "basic_2"] },
    h,
  );
  expect(result.sources[0]?.excerpt).toHaveLength(16000);
  expect(result.sources[0]?.excerpt.endsWith("\n[TRUNCATED]")).toBe(true);
  expect(result.sources[0]?.contentScope).toBe("snippet");
  expect(JSON.stringify(h.provider.search.mock.calls)).not.toContain(
    "x".repeat(100),
  );
});
it("force refresh ignores previous-run cache and creates new evidence IDs", async () => {
  const h = harness(),
    source = webEvidence({
      url: "https://wine.test/a",
      domain: "wine.test",
      capturedAt: now,
    });
  h.store.cache = async (_, key) => ({
    ...key,
    snapshotId: request.runId,
    runId: "previous-run",
    capturedAt: now,
    payload: { schemaVersion: 1, sources: [source] },
  });
  const result = await acquireWineEvidence(
    { ...request, forceRefresh: true },
    { stage: "basic", slots: ["basic_1"] },
    h,
  );
  expect(h.provider.search).toHaveBeenCalledOnce();
  expect(result.sources[0]?.id).not.toBe(source.id);
});
it("rejects injected source IDs before Extract", async () => {
  const h = harness();
  const result = await acquireWineEvidence(
    request,
    { stage: "extract", sourceIds: [request.runId] },
    h,
  );
  expect(result.warnings).toContain("invalid_extract_candidates");
  expect(h.provider.extract).not.toHaveBeenCalled();
});
it("runs only one Extract slot and rejects foreign result provenance", async () => {
  const h = harness();
  await acquireWineEvidence(request, { stage: "basic", slots: ["basic_1"] }, h);
  const sourceIds = h.sources
    .filter((s) => s.contentScope === "snippet")
    .map((s) => s.id);
  h.provider.extract.mockResolvedValue({
    credits: 1,
    requestId: null,
    results: [
      {
        url: "https://foreign.test/a",
        title: "",
        content: "foreign",
        rawContent: "foreign",
      },
    ],
  } as never);
  const result = await acquireWineEvidence(
    request,
    { stage: "extract", sourceIds },
    h,
  );
  await acquireWineEvidence(request, { stage: "extract", sourceIds }, h);
  expect(h.provider.extract).toHaveBeenCalledOnce();
  expect(result.warnings).toContain("invalid_output");
  expect(h.calls.get("extract_1")?.status).toBe("unknown");
});
it("rejects malformed direct callback results at the acquisition boundary", async () => {
  const h = harness();
  const valid = await h.document({
    workspaceId: request.workspaceId,
    runId: request.runId,
    sourceId: request.runId,
    inputRevision: 0,
    kind: "product",
  });
  h.document.mockImplementation(async (input) => ({
    ...valid,
    ...input,
    text: "x".repeat(16001),
  }));
  const result = await acquireWineEvidence(
    request,
    { stage: "basic", slots: ["basic_1"] },
    h,
  );
  expect(result.sources[0]?.contentScope).toBe("snippet");
  expect(result.warnings).toContain("document_unavailable");
});

it("replays one successful Extract with immutable new evidence", async () => {
  const h = harness();
  await acquireWineEvidence(request, { stage: "basic", slots: ["basic_1"] }, h);
  const sourceIds = h.sources
    .filter((s) => s.contentScope === "snippet")
    .map((s) => s.id);
  h.provider.extract.mockResolvedValue({
    credits: 1,
    requestId: null,
    results: [
      {
        url: "https://wine.test/a",
        title: "",
        content: "extracted",
        rawContent: "extracted",
      },
    ],
  });
  const first = await acquireWineEvidence(
    request,
    { stage: "extract", sourceIds },
    h,
  );
  const second = await acquireWineEvidence(
    request,
    { stage: "extract", sourceIds },
    h,
  );
  expect(first).toEqual(second);
  expect(h.provider.extract).toHaveBeenCalledOnce();
  expect(first.sources[0]?.location).toContain(sourceIds[0]);
  expect(first.sources[0]?.contentScope).toBe("document");
});
it("preserves measured cost discrepancy and stops the next basic query", async () => {
  const h = harness();
  h.provider.search.mockResolvedValue({
    credits: 9,
    requestId: null,
    results: [],
  });
  const result = await acquireWineEvidence(
    request,
    { stage: "basic", slots: ["basic_1", "basic_2"] },
    h,
  );
  expect(h.provider.search).toHaveBeenCalledOnce();
  expect(result.warnings).toContain("cost_discrepancy");
  expect(h.calls.get("basic_1")?.diagnostic?.measuredCredits).toBe(9);
});

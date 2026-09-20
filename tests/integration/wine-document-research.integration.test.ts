import { expect, it } from "vitest";
import {
  db,
  extracted,
} from "../../apps/worker/src/wine-research.integration-fixture.js";
import { createWineResearchHandler } from "../../apps/worker/src/wine-research-handler.js";
import { runWineStage } from "../../apps/worker/src/wine-enrichment-pipeline.js";
import {
  verifyQueueRequest,
  WINE_DOCUMENT_PATH,
} from "../../packages/jobs/src/index.js";
import { createWineDocumentStore } from "../../packages/db/src/index.js";
import { createWineDocumentService } from "../../apps/web/lib/website/wine-document-service.js";
type Fixture = Awaited<ReturnType<typeof extracted>>;
function synthetic(
  f: Fixture,
  document: ReturnType<typeof createWineDocumentService>,
) {
  const calls: string[] = [];
  const execute = createWineResearchHandler({
    database: db,
    tavilyApiKey: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    queueSecret: "synthetic",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (String(url).includes("api.tavily.com")) {
        const slot = body.urls
          ? "extract_1"
          : body.search_depth === "advanced"
            ? "advanced_1"
            : body.query.includes("technical")
              ? "basic_2"
              : "basic_1";
        calls.push(slot);
        expect(
          await db.forWorkspace(f.workspaceId, (r) =>
            r.wineEnrichment.readSearchCall(f.run.id, slot),
          ),
        ).toMatchObject({ status: "started" });
        return Response.json({
          request_id: "synthetic",
          usage: { credits: slot === "advanced_1" ? 2 : 1 },
          results: body.urls
            ? body.urls.map((url: string) => ({
                url,
                raw_content: "Producer: Contrary Estate\nABV: 14 %",
              }))
            : Array.from({ length: 5 }, (_, i) => ({
                url: `https://wine.test/${slot}/${i}`,
                title: "Synthetic",
                content:
                  "Producer: Unrelated Estate\nProduct: Unrelated bottle\nABV: 14 %",
              })),
          failed_results: [],
        });
      }
      calls.push("document");
      const headers = new Headers(init!.headers);
      expect(
        await verifyQueueRequest({
          secret: "synthetic",
          nowSeconds: Math.floor(Date.now() / 1000),
          timestamp: headers.get("x-wukong-timestamp")!,
          signature: headers.get("x-wukong-signature")!,
          path: WINE_DOCUMENT_PATH,
          body: String(init!.body),
        }),
      ).toBe(true);
      return Response.json(await document(body));
    },
  });
  return { execute, calls };
}
async function basic(
  f: Fixture,
  execute: ReturnType<typeof createWineResearchHandler>,
) {
  return runWineStage(
    { ...f.job, stage: "search_basic" },
    { store: f.store, execute },
  );
}
it("composes persisted document safety approval with one bounded Extract batch for client-rendered pages", async () => {
  const f = await extracted();
  const requests: string[] = [];
  const document = createWineDocumentService({
    store: createWineDocumentStore(db),
    wait: async () => {},
    publicFetch: async ({ url, kind }) => {
      requests.push(kind);
      return {
        url,
        status: 200,
        capturedAt: new Date().toISOString(),
        contentType: kind === "robots" ? "text/plain" : "text/html",
        retryAfterSeconds: null,
        text:
          kind === "robots"
            ? "User-agent: *\nAllow: /"
            : '<html><body><div id="app"></div><script>renderWine()</script></body></html>',
      };
    },
  });
  const s = synthetic(f, document);
  const observed = await basic(f, s.execute);
  expect(observed).toEqual({ status: "advanced", nextStage: "verification" });
  expect(s.calls.filter((x) => x === "extract_1")).toHaveLength(1);
  const rows = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  const children = rows.filter((x) =>
    x.location.startsWith("tavily:extract_1"),
  );
  expect(children).toHaveLength(5);
  expect(children.every((x) => x.title === "Synthetic")).toBe(true);
  expect(children.every((x) => x.trust === "unverified")).toBe(true);
  // Ten distinct search snippets were fetched; Extract approval replays their immutable results.
  expect(requests.filter((x) => x === "product")).toHaveLength(10);
  const parent = rows.find(
    (x) => x.id === children[0]!.location.split(";source:")[1],
  )!;
  const replay = await document({
    workspaceId: f.workspaceId,
    runId: f.run.id,
    sourceId: parent.id,
    inputRevision: f.job.inputRevision,
    kind: "product",
  });
  expect(replay).toMatchObject({
    status: "completed",
    result: {
      state: "ready",
      text: "",
      spans: [],
      extractEligible: true,
    },
  });
  expect(requests.filter((x) => x === "product")).toHaveLength(10);
  expect(await basic(f, s.execute)).toEqual({ status: "duplicate" });
  expect(s.calls.filter((x) => x === "extract_1")).toHaveLength(1);
});

import { describe, expect, it, vi } from "vitest";
import { webEvidence } from "@wukong/core";
import {
  createWineDocumentService,
  type WineDocumentContext,
  type WineDocumentStore,
} from "./wine-document-service";
import { createPublicFetch, type PublicFetch } from "./public-fetch";
const now = new Date("2026-09-16T00:00:00.000Z");
const input = {
  workspaceId: "ws",
  runId: "10000000-0000-4000-8000-000000000001",
  sourceId: "00000000-0000-4000-8000-000000000001",
  inputRevision: 2,
  kind: "product" as const,
};
function context(): WineDocumentContext {
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    source: webEvidence({
      url: "https://wine.example/product",
      domain: "wine.example",
      contentScope: "snippet",
    }),
    inputRevision: 2,
    currentInputRevision: 2,
    currentRunId: input.runId,
    flowVersion: "wine-enrichment-v1",
    executionState: "running",
    acceptedAt: now.toISOString(),
    deadlineAt: "2026-09-16T00:15:00.000Z",
    allowedDomains: ["wine.example"],
  };
}
function fixture(
  change: Partial<WineDocumentContext> = {},
  fetch?: PublicFetch,
) {
  const saved: unknown[] = [];
  let claimed = false;
  const store: WineDocumentStore = {
    claim: vi.fn(async () =>
      claimed
        ? { state: "unknown" as const }
        : ((claimed = true),
          { state: "claimed" as const, context: { ...context(), ...change } }),
    ),
    finish: vi.fn(async (_input, result) => {
      saved.push(result);
      return true;
    }),
  };
  const publicFetch = vi.fn(
    fetch ??
      (async ({ url, kind }) => ({
        url,
        status: 200,
        text:
          kind === "robots"
            ? "User-agent: *\nAllow: /"
            : "<html><title>Estate history</title><article><p>Founded in 1900.</p></article></html>",
        contentType: kind === "robots" ? "text/plain" : "text/html",
        capturedAt: now.toISOString(),
        retryAfterSeconds: null,
      })),
  );
  const wait = vi.fn(async () => undefined);
  return {
    store,
    publicFetch,
    saved,
    wait,
    service: createWineDocumentService({
      store,
      publicFetch,
      wait,
      now: () => now,
    }),
  };
}
describe("wine document service", () => {
  it("extracts generic article text and retained spans when Product JSON-LD is absent", async () => {
    const f = fixture();
    const result = await f.service(input);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.text).toBe("Founded in 1900.");
    expect(result.result.spans).toEqual([
      { start: 0, end: 16, location: "article:text" },
    ]);
    expect(result.result.documentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.result.extractEligible).toBe(true);
    expect(f.publicFetch.mock.calls.map(([call]) => call.kind)).toEqual([
      "robots",
      "product",
    ]);
    expect(f.saved).toHaveLength(1);
    expect(f.wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
  });
  it.each([
    { workspaceId: "foreign" },
    { runId: "foreign" },
    { inputRevision: 1 },
    { currentInputRevision: 3 },
    { currentRunId: "foreign" },
    { executionState: "succeeded" },
    { flowVersion: "legacy" },
    { deadlineAt: now.toISOString() },
    { deadlineAt: "2026-09-16T00:16:00.000Z" },
    { acceptedAt: "invalid" },
    { allowedDomains: ["other.example"] },
    { source: webEvidence({ id: "20000000-0000-4000-8000-000000000002" }) },
  ])("rejects stale or mismatched persisted context %j", async (change) => {
    const f = fixture(change);
    expect((await f.service(input)).status).toBe("stale");
    expect(f.publicFetch).not.toHaveBeenCalled();
  });
  it("denies product fetch and Extract eligibility after robots refusal", async () => {
    const f = fixture({}, async ({ url }) => ({
      url,
      status: 403,
      text: "",
      contentType: "text/plain",
      capturedAt: now.toISOString(),
      retryAfterSeconds: null,
    }));
    const out = await f.service(input);
    expect(out.status === "completed" && out.result.state).toBe("denied");
    expect(out.status === "completed" && out.result.extractEligible).toBe(
      false,
    );
    expect(f.publicFetch).toHaveBeenCalledTimes(1);
  });
  it("checks robots rules at redirect hops", async () => {
    const f = fixture({}, async (call) => {
      if (call.kind === "robots")
        return {
          url: call.url,
          status: 200,
          text: "User-agent: *\nDisallow: /private",
          contentType: "text/plain",
          capturedAt: now.toISOString(),
          retryAfterSeconds: null,
        };
      expect(call.approveUrl?.("https://wine.example/private")).toBe(false);
      expect(call.approveUrl?.("https://other.example/product")).toBe(false);
      return {
        url: call.url,
        status: 403,
        text: "",
        contentType: "text/html",
        capturedAt: now.toISOString(),
        retryAfterSeconds: null,
      };
    });
    const out = await f.service(input);
    expect(out.status === "completed" && out.result.extractEligible).toBe(
      false,
    );
  });
  it("uses production transport to reject private-address redirects", async () => {
    const request = vi.fn(async () => ({
      status: 302,
      contentType: "text/plain",
      body: [],
      location: "https://127.0.0.1/secret",
    }));
    const f = fixture(
      {},
      createPublicFetch({
        resolve: async () => [{ address: "8.8.8.8", family: 4 }],
        request,
      }),
    );
    const out = await f.service(input);
    expect(out.status === "completed" && out.result.state).toBe("unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("bounds retained text with a marker and valid source spans", async () => {
    const f = fixture({}, async ({ url, kind }) => ({
      url,
      status: 200,
      text:
        kind === "robots"
          ? "User-agent: *\nAllow: /"
          : `<article>${"x".repeat(17000)}</article>`,
      contentType: kind === "robots" ? "text/plain" : "text/html",
      capturedAt: now.toISOString(),
      retryAfterSeconds: null,
    }));
    const out = await f.service(input);
    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;
    expect(out.result.text.length).toBe(16000);
    expect(out.result.text.endsWith("[TRUNCATED]")).toBe(true);
    expect(out.result.truncated).toBe(true);
    expect(out.result.spans[0]!.end).toBeLessThan(16000);
  });
  it("never repeats network for an unknown claim", async () => {
    const f = fixture();
    await f.service(input);
    expect((await f.service(input)).status).toBe("unknown");
    expect(f.publicFetch).toHaveBeenCalledTimes(2);
  });
  it("replays persisted terminal output without network", async () => {
    const f = fixture();
    const first = await f.service(input);
    if (first.status !== "completed") throw Error("fixture failed");
    f.store.claim = async () => ({ state: "completed", result: first.result });
    expect(await f.service(input)).toEqual(first);
    expect(f.publicFetch).toHaveBeenCalledTimes(2);
  });
});

it("does not shorten oversized robots crawl delays into an early product request", async () => {
  const f = fixture({}, async ({ url, kind }) => ({
    url,
    status: 200,
    text:
      kind === "robots"
        ? "User-agent: *\nCrawl-delay: 3000000\nAllow: /"
        : "<article>Text</article>",
    contentType: kind === "robots" ? "text/plain" : "text/html",
    capturedAt: now.toISOString(),
    retryAfterSeconds: null,
  }));
  const out = await f.service(input);
  expect(out.status === "completed" && out.result.state).toBe("unavailable");
  expect(f.publicFetch).toHaveBeenCalledTimes(1);
  expect(f.wait).not.toHaveBeenCalled();
});
it("preserves visible block and line boundaries for deterministic wine identity labels", async () => {
  const f = fixture({}, async ({ url, kind }) => ({
    url,
    status: 200,
    contentType: kind === "robots" ? "text/plain" : "text/html",
    capturedAt: now.toISOString(),
    retryAfterSeconds: null,
    text:
      kind === "robots"
        ? "User-agent: *\nAllow: /"
        : `<html><title> Synthetic   identity </title><article><p>Kind: wine</p><p>Producer: <strong>Fixture</strong> Estate</p><ul><li>Product: Reserve Red</li><li>Vintage: 2020</li></ul><div>Volume: 750 ml<br>Pack quantity: 1 bottles<br>ABV: 13%</div><script>Producer: Forged</script><style>Product: Forged</style><template>Vintage: 1900</template><nav>Volume: 1 ml</nav></article></html>`,
  }));
  const out = await f.service(input);
  expect(out.status).toBe("completed");
  if (out.status !== "completed") throw Error("expected document");
  expect(out.result.text).toBe(
    "Kind: wine\nProducer: Fixture Estate\nProduct: Reserve Red\nVintage: 2020\nVolume: 750 ml\nPack quantity: 1 bottles\nABV: 13%",
  );
  expect(out.result.title).toBe("Synthetic identity");
  expect(out.result.spans[0]).toMatchObject({
    start: 0,
    end: out.result.text.length,
  });
  expect(out.result.text).not.toContain("Forged");
});

it.each([200, 401, 403, 429, 404, 500])(
  "separates accessible empty HTML from access failures: %s",
  async (status) => {
    const f = fixture({}, async ({ url, kind }) => ({
      url,
      status: kind === "robots" ? 200 : status,
      text:
        kind === "robots"
          ? "User-agent: *\nAllow: /"
          : '<html><body><div id="app"></div><script>render()</script></body></html>',
      contentType: kind === "robots" ? "text/plain" : "text/html",
      capturedAt: now.toISOString(),
      retryAfterSeconds: null,
    }));
    const out = await f.service(input);
    expect(out).toMatchObject({
      status: "completed",
      result: {
        state:
          status === 200
            ? "ready"
            : [401, 403, 429].includes(status)
              ? "denied"
              : "unavailable",
        text: "",
        spans: [],
        extractEligible: status === 200,
      },
    });
  },
);
it("keeps old immutable unavailable results ineligible without network retry", async () => {
  const f = fixture();
  const first = await f.service(input);
  if (first.status !== "completed") throw Error("fixture failed");
  const old = {
    ...first.result,
    state: "unavailable" as const,
    text: "",
    spans: [],
    extractEligible: false,
  };
  f.store.claim = async () => ({ state: "completed", result: old });
  expect(await f.service(input)).toEqual({ status: "completed", result: old });
  expect(f.publicFetch).toHaveBeenCalledTimes(2);
});

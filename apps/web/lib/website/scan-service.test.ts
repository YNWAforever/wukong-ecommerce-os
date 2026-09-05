import { describe, expect, it, vi } from "vitest";
import type { WebsiteScan } from "@wukong/db";
import {
  advanceWebsiteDocument,
  createWebsiteDocumentService,
} from "./scan-service";
import { parseRobots } from "./robots-policy";

const origin = "https://store.example/";
const now = new Date("2026-09-06T00:00:00Z");
function scan(
  kind: "robots" | "discovery" | "product" = "robots",
): WebsiteScan {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workspaceId: "ws",
    revision: 0,
    nextEligibleAt: now,
    deadlineAt: new Date(now.getTime() + 900000),
    robotsRequests: 1,
    discoveryRequests: 0,
    productRequests: 0,
    checkpoint: {
      seedUrl: origin,
      canonicalOrigin: kind === "product" ? origin : null,
      robotsPolicy:
        kind === "robots"
          ? null
          : parseRobots({
              url: origin + "robots.txt",
              status: 200,
              text: "User-agent: *\nDisallow: /private",
            }),
      pending: {
        url:
          kind === "robots"
            ? origin + "robots.txt"
            : kind === "product"
              ? origin + "products/one"
              : origin,
        kind,
      },
      discoveryUrls: [],
      candidateUrls: kind === "product" ? [origin + "products/one"] : [],
      visitedUrls: [],
      nextEligibleAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 900000).toISOString(),
      preview: { products: [], warnings: [] },
    },
  } as unknown as WebsiteScan;
}
const doc = (url: string, text: string, status = 200) => ({
  url,
  text,
  status,
  capturedAt: now.toISOString(),
  contentType: "text/html",
  retryAfterSeconds: null,
});
describe("website document orchestration", () => {
  it("plans robots then seed discovery with the persisted delay", () => {
    const s = scan();
    s.nextEligibleAt = new Date(now.getTime() + 5000);
    const result = advanceWebsiteDocument(
      s,
      {
        ...doc(origin + "robots.txt", "User-agent: *\nCrawl-delay: 2"),
        contentType: "text/plain",
      },
      now,
    );
    expect(result.checkpoint.pending).toEqual({
      url: origin,
      kind: "discovery",
    });
    expect(result.checkpoint.canonicalOrigin).toBeNull();
    expect(result.checkpoint.nextEligibleAt).toBe(
      new Date(now.getTime() + 5000).toISOString(),
    );
  });
  it("reapproves redirected origin before retaining any product evidence", () => {
    const result = advanceWebsiteDocument(
      scan("discovery"),
      doc(
        "https://www.store.example/",
        '<script type="application/ld+json">{"@type":"Product","name":"One"}</script>',
      ),
      now,
    );
    expect(result.checkpoint.canonicalOrigin).toBe(
      "https://www.store.example/",
    );
    expect(result.checkpoint.pending).toEqual({
      url: "https://www.store.example/robots.txt",
      kind: "robots",
    });
    expect(result.checkpoint.preview.products).toEqual([]);
  });
  it("binds product observations to final URLs and ends ready", () => {
    const result = advanceWebsiteDocument(
      scan("product"),
      doc(
        origin + "products/renamed",
        '<script type="application/ld+json">{"@type":"Product","name":"One"}</script>',
      ),
      now,
    );
    expect(result.state).toBe("ready");
    expect(result.documentUrl).toBe(origin + "products/renamed");
    expect(result.checkpoint.preview.products[0]?.sourceUrl).toBe(
      origin + "products/renamed",
    );
  });
  it("stops rate-limited robots without automatic retry", () => {
    const result = advanceWebsiteDocument(
      scan(),
      doc(origin + "robots.txt", "", 429),
      now,
    );
    expect(result.state).toBe("failed");
    expect(result.checkpoint.pending).toBeNull();
  });
  it("never exceeds bounded discovery and product candidate collections", () => {
    const html = Array.from(
      { length: 40 },
      (_, i) => `<a href="/products/${i}">Product</a>`,
    ).join("");
    const result = advanceWebsiteDocument(
      scan("discovery"),
      doc(origin, html),
      now,
    );
    expect(result.checkpoint.candidateUrls).toHaveLength(20);
    expect(result.checkpoint.discoveryUrls.length).toBeLessThanOrEqual(5);
  });
  it.each(["completed", "in_progress", "stale"])(
    "does not fetch a %s callback",
    async (status) => {
      const fetch = vi.fn();
      const result = {
        state: "failed",
        checkpoint: { ...scan().checkpoint, pending: null },
        documentUrl: null,
      };
      const db = {
        forWorkspace: async (_ws: string, work: any) =>
          work({
            websiteCatalog: {
              beginDocumentFetch: async () => ({ status, result }),
            },
          }),
      };
      const service = createWebsiteDocumentService({
        database: db as any,
        publicFetch: fetch,
        now: () => now,
      });
      expect(
        (
          await service({
            kind: "website_scan",
            workspaceId: "ws",
            scanId: scan().id,
            revision: 0,
            leaseToken: scan().id,
          })
        ).status,
      ).toBe(status);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("commits fetch claim before I/O and completes in a separate transaction", async () => {
    let inTransaction = false;
    const completeStep = vi.fn(async () => ({}));
    const s = scan();
    const database = {
      forWorkspace: async (_ws: string, work: any) => {
        inTransaction = true;
        try {
          return await work({
            websiteCatalog: {
              beginDocumentFetch: async () => ({
                status: "claimed",
                scan: s,
                step: { ...s.checkpoint.pending, lockedOrigin: null },
              }),
              completeStep,
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    };
    const publicFetch = vi.fn(async () => {
      expect(inTransaction).toBe(false);
      return { ...doc(origin + "robots.txt", ""), contentType: "text/plain" };
    });
    const service = createWebsiteDocumentService({
      database: database as any,
      publicFetch,
      now: () => now,
    });
    expect(
      (
        await service({
          kind: "website_scan",
          workspaceId: "ws",
          scanId: s.id,
          revision: 0,
          leaseToken: s.id,
        })
      ).status,
    ).toBe("completed");
    expect(completeStep).toHaveBeenCalledOnce();
  });
  it("evaluates robots before the requested product path", async () => {
    const s = scan("product");
    s.checkpoint.pending!.url = origin + "private/one";
    const fetch = vi.fn();
    const completeStep = vi.fn();
    const database = {
      forWorkspace: async (_ws: string, work: any) =>
        work({
          websiteCatalog: {
            beginDocumentFetch: async () => ({
              status: "claimed",
              scan: s,
              step: { ...s.checkpoint.pending, lockedOrigin: origin },
            }),
            completeStep,
          },
        }),
    };
    await createWebsiteDocumentService({
      database: database as any,
      publicFetch: fetch,
      now: () => now,
    })({
      kind: "website_scan",
      workspaceId: "ws",
      scanId: s.id,
      revision: 0,
      leaseToken: s.id,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(completeStep).toHaveBeenCalled();
  });
});

it("plans explicit canonical redirect reapproval without treating its target as fetched", () => {
  const s = scan("discovery");
  const document = {
    ...doc(origin, "", 301),
    redirectedTo: "https://www.store.example/",
  };
  const result = advanceWebsiteDocument(s, document, now);
  expect(result).toMatchObject({
    documentUrl: origin,
    redirectedTo: "https://www.store.example/",
    state: "running",
  });
  expect(result.checkpoint.pending).toEqual({
    url: "https://www.store.example/robots.txt",
    kind: "robots",
  });
  expect(result.checkpoint.preview.products).toEqual([]);
});

it("reports dispatch unavailability without exposing internal configuration", async () => {
  const s = scan();
  Object.assign(s, {
    requestedUrl: origin,
    updatedAt: now,
    state: "queued",
    dispatchStatus: "failed",
  });
  const { publicWebsiteScan } = await import("./scan-service");
  expect(publicWebsiteScan(s).warnings).toContain("website_scan_unavailable");
});

it("resumes the full redirected path and query after canonical robots approval", () => {
  const before = scan("discovery");
  const target = "https://www.store.example/new?colour=red";
  const redirected = advanceWebsiteDocument(
    before,
    { ...doc(origin + "old", "", 301), redirectedTo: target },
    now,
  );
  expect(redirected.checkpoint.discoveryUrls).toEqual([target]);
  const reapproval = {
    ...before,
    checkpoint: redirected.checkpoint,
    nextEligibleAt: new Date(now.getTime() + 1000),
  };
  const approved = advanceWebsiteDocument(
    reapproval,
    {
      ...doc("https://www.store.example/robots.txt", ""),
      contentType: "text/plain",
    },
    new Date(now.getTime() + 1000),
  );
  expect(approved.checkpoint.pending).toEqual({
    url: target,
    kind: "discovery",
  });
});
it("fetches canonical identity before retaining product evidence and stops canonical cycles", () => {
  const before = scan("product");
  before.checkpoint.pending!.url = origin + "products/one?ref=x";
  before.checkpoint.candidateUrls = [before.checkpoint.pending!.url];
  const html =
    '<link rel="canonical" href="/products/one"><script type="application/ld+json">{"@type":"Product","name":"One"}</script>';
  const next = advanceWebsiteDocument(
    before,
    doc(before.checkpoint.pending!.url, html),
    now,
  );
  expect(next.checkpoint.preview.products).toEqual([]);
  expect(next.checkpoint.pending).toEqual({
    url: origin + "products/one",
    kind: "product",
  });
  const canonical = {
    ...before,
    checkpoint: next.checkpoint,
    productRequests: 2,
  };
  const cycle = advanceWebsiteDocument(
    canonical,
    doc(
      origin + "products/one",
      html.replace('/products/one"', '/products/one?ref=x"'),
    ),
    new Date(now.getTime() + 1000),
  );
  expect(cycle.state).toBe("failed");
  expect(cycle.checkpoint.pending).toBeNull();
  expect(cycle.checkpoint.preview.warnings).toContain("canonical_cycle");
});

it("does not refetch an already observed canonical identity", () => {
  const html =
    '<link rel="canonical" href="/products/one"><script type="application/ld+json">{"@type":"Product","name":"One"}</script>';
  const before = scan("product");
  const canonical = origin + "products/one";
  before.checkpoint.preview = advanceWebsiteDocument(
    before,
    doc(canonical, html),
    now,
  ).checkpoint.preview;
  before.checkpoint.pending!.url = canonical + "?ref=x";
  before.checkpoint.candidateUrls = [before.checkpoint.pending!.url, canonical];
  const result = advanceWebsiteDocument(
    before,
    doc(before.checkpoint.pending!.url, html),
    now,
  );
  expect(result.state).toBe("ready");
  expect(result.checkpoint.pending).toBeNull();
  expect(result.checkpoint.preview.products).toEqual(
    before.checkpoint.preview.products,
  );
});
it("does not follow disallowed canonical identities or exceed the product budget", () => {
  const html =
    '<link rel="canonical" href="/private/one"><script type="application/ld+json">{"@type":"Product","name":"One"}</script>';
  const denied = advanceWebsiteDocument(
    scan("product"),
    doc(origin + "products/one", html),
    now,
  );
  expect(denied.state).toBe("failed");
  expect(denied.checkpoint.preview.warnings).toContain("canonical_disallowed");
  expect(denied.checkpoint.pending).toBeNull();
  const before = scan("product");
  before.productRequests = 20;
  before.checkpoint.preview = advanceWebsiteDocument(
    scan("product"),
    doc(
      origin + "products/saved",
      '<script type="application/ld+json">{"@type":"Product","name":"Saved"}</script>',
    ),
    now,
  ).checkpoint.preview;
  const budget = advanceWebsiteDocument(
    before,
    doc(
      origin + "products/one",
      html.replace("/private/one", "/products/canonical"),
    ),
    now,
  );
  expect(budget.state).toBe("partial");
  expect(budget.checkpoint.preview.products).toEqual(
    before.checkpoint.preview.products,
  );
  expect(budget.checkpoint.pending).toBeNull();
  expect(budget.checkpoint.preview.warnings).toContain("scan_budget_reached");
});

it("passes the persisted robots delay and path approval into protected transport", async () => {
  const s = scan("product");
  s.checkpoint.robotsPolicy!.crawlDelaySeconds = 2.5;
  const publicFetch = vi.fn(
    async (_input: Parameters<import("./public-fetch").PublicFetch>[0]) =>
      doc(
        s.checkpoint.pending!.url,
        '<script type="application/ld+json">{"@type":"Product","name":"One"}</script>',
      ),
  );
  const database = {
    forWorkspace: async (_ws: string, work: any) =>
      work({
        websiteCatalog: {
          beginDocumentFetch: async () => ({
            status: "claimed",
            scan: s,
            step: { ...s.checkpoint.pending, lockedOrigin: origin },
          }),
          completeStep: async () => ({}),
        },
      }),
  };
  await createWebsiteDocumentService({
    database: database as any,
    publicFetch,
    now: () => now,
  })({
    kind: "website_scan",
    workspaceId: "ws",
    scanId: s.id,
    revision: 0,
    leaseToken: s.id,
  });
  const input = publicFetch.mock.calls[0]![0];
  expect(input.crawlDelaySeconds).toBe(2.5);
  expect(input.approveUrl!(origin + "private/one")).toBe(false);
  expect(input.approveUrl!(origin + "products/one")).toBe(true);
});

import { expect, it } from "vitest";
import {
  parseCatalogQuery,
  parseJobsQuery,
  catalogQuery,
  jobsQuery,
  catalogContextKey,
} from "./catalog-query-state";
import { normalizeWorkbenchReturn } from "./workbench-navigation";

it("uses one canonical context for scroll and return, retaining responsibility and import scope", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(
    catalogContextKey(
      `page=2&filter=review&q=000674&work=mine&importId=${id}&returnTo=/jobs`,
    ),
  ).toBe(
    catalogContextKey(`q=000674&filter=review&page=2&importId=${id}&work=mine`),
  );
  expect(catalogContextKey("page=1&filter=all")).toBe("/catalog");
  expect(parseCatalogQuery("work=foreign").work).toBe("all");
  expect(catalogContextKey("work=mine")).not.toBe(
    catalogContextKey("work=unassigned"),
  );
});

it("keeps zero-prefixed SKU search and validates bounded pages/filters identically", () => {
  expect(parseCatalogQuery("q=000674&page=2&filter=review")).toMatchObject({
    q: "000674",
    page: 2,
    filter: "review",
  });
  expect(parseCatalogQuery("q=x&page=0002&filter=bogus")).toMatchObject({
    q: "x",
    page: 1,
    filter: "all",
  });
  expect(parseCatalogQuery("importId=../foreign").invalidImport).toBe(true);
  expect(parseCatalogQuery("q=" + "x".repeat(201)).q.length).toBe(200);
});
it("serializes a query change at page one without an intermediate old-page request", () => {
  const old = parseCatalogQuery("q=old&page=8&filter=review");
  expect(catalogQuery({ ...old, q: "000674", page: 1 })).toBe(
    "q=000674&filter=review",
  );
  expect(jobsQuery({ kind: "export", page: 2 })).toBe("kind=export&page=2");
  expect(parseJobsQuery("kind=unknown&page=-1")).toEqual({
    kind: "all",
    page: 1,
  });
});
it("allows bounded catalog/jobs returns without unrelated query data or redirects", () => {
  expect(
    normalizeWorkbenchReturn(
      "/catalog?q=000674&filter=review&page=2&secret=hidden",
    ),
  ).toBe("/catalog?q=000674&filter=review&page=2");
  expect(
    normalizeWorkbenchReturn("/jobs?kind=export&page=2&prompt=hidden"),
  ).toBe("/jobs?kind=export&page=2");
  expect(normalizeWorkbenchReturn("//evil.test/catalog")).toBe("/dashboard");
});
it("retains opaque cursors in canonical/back links and explicitly clears them on a new search", () => {
  const old = parseCatalogQuery(
    "q=000674&page=8&filter=review&cursor=opaque-position",
  );
  expect(
    catalogContextKey("filter=review&cursor=opaque-position&page=8&q=000674"),
  ).toBe("/catalog?q=000674&filter=review&page=8&cursor=opaque-position");
  expect(catalogQuery({ ...old, q: "new", page: 1, cursor: undefined })).toBe(
    "q=new&filter=review",
  );
  expect(
    normalizeWorkbenchReturn("/jobs?kind=export&page=3&cursor=opaque-job"),
  ).toBe("/jobs?kind=export&page=3&cursor=opaque-job");
  expect(parseCatalogQuery("cursor=../../foreign").cursor).toBe("invalid");
});

import { describe, expect, it } from "vitest";

import { createListingHandler } from "./listings/route.js";

const sessionContext = {
  async resolve() {
    return { workspaceId: "ws_opak", actorId: "user_1", role: "operator" } as const;
  },
};

const uuid = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

function requestFor(sourceAssetIds: string[]) {
  return new Request("http://localhost/api/listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceAssetIds, note: "intake" }),
  });
}

function harness(kinds: string[]) {
  const mutations: string[] = [];
  const ids = kinds.map((_kind, index) => uuid(index + 1));
  const repositories = {
    sourceAssets: {
      async getByIds() {
        return kinds.map((kind, index) => ({ id: ids[index], kind, listingId: null }));
      },
      async attachToListing() {
        mutations.push("attach");
      },
    },
    listings: {
      async create() {
        mutations.push("create");
        return { id: uuid(999), status: "received", target: "shopline" };
      },
    },
    audit: {
      async write() {
        mutations.push("audit");
      },
    },
  };
  const handler = createListingHandler({
    sessionContext,
    publisher: { async enqueue() { return { id: "job_test" }; } },
    getAssetStore: () => {
      throw new Error("unused");
    },
    getDatabase: () => ({
      async forWorkspace<T>(
        _workspaceId: string,
        work: (repos: typeof repositories) => Promise<T>,
      ) {
        return work(repositories);
      },
    }) as never,
  });
  return { handler, ids, mutations };
}

describe("listing source composition", () => {
  it("rejects 11 images without mutation or audit", async () => {
    const test = harness(Array.from({ length: 11 }, () => "image/jpeg"));

    const response = await test.handler(requestFor(test.ids));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_asset_composition" });
    expect(test.mutations).toEqual([]);
  });

  it("rejects 2 PDFs without mutation or audit", async () => {
    const test = harness(["application/pdf", "application/pdf"]);

    const response = await test.handler(requestFor(test.ids));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_asset_composition" });
    expect(test.mutations).toEqual([]);
  });

  it("accepts the boundary of 10 images and 1 PDF", async () => {
    const test = harness([
      ...Array.from({ length: 10 }, () => "image/webp"),
      "application/pdf",
    ]);

    const response = await test.handler(requestFor(test.ids));

    expect(response.status).toBe(201);
    expect(test.mutations).toEqual(["create", "attach", "audit"]);
  });
});

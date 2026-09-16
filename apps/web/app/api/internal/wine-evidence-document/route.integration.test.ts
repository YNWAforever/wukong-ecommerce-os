import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { webEvidence } from "@wukong/core";
import { createDatabase, createWineDocumentStore } from "@wukong/db";
import { signQueueRequest, WINE_DOCUMENT_PATH } from "@wukong/jobs";
import { createWineEvidenceDocumentPost } from "./route";

const database = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
const secret = "synthetic-route-integration-secret";

beforeAll(async () => {
  await database.migrate();
  await admin.unsafe(
    await readFile(
      new URL(
        "../../../../../../packages/db/drizzle/0042_wine_acquisition.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

afterAll(async () => {
  await database.close();
  await admin.end();
});

async function fixture(
  options: {
    workspaceId?: string;
    deadlineAt?: string;
    wineMode?: string;
    allowedDomains?: string[];
  } = {},
) {
  const workspaceId = options.workspaceId ?? `route-${randomUUID()}`;
  const source = webEvidence({
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    url: "https://example.test/wine",
    domain: "example.test",
  });
  return database.forWorkspace(workspaceId, async (repos) => {
    const listing = await repos.listings.create({ target: "shopline" });
    const run = await repos.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        wineMode: options.wineMode ?? "full",
        wineAcquisition: {
          schemaVersion: 1,
          deadlineAt:
            options.deadlineAt ?? new Date(Date.now() + 840_000).toISOString(),
          policyVersion: "p1",
          rulesVersion: "r1",
          allowedDomains: options.allowedDomains ?? ["example.test"],
        },
      },
    });
    await repos.wineEnrichment.saveEvidence(run.id, [source]);
    return {
      workspaceId,
      listing,
      run,
      source,
      request: {
        workspaceId,
        runId: run.id,
        sourceId: source.id,
        inputRevision: 0,
        kind: "product" as const,
      },
    };
  });
}

async function signedRequest(
  payload: Awaited<ReturnType<typeof fixture>>["request"],
) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(`https://app.example${WINE_DOCUMENT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wukong-timestamp": String(timestamp),
      "x-wukong-signature": await signQueueRequest({
        secret,
        timestamp,
        path: WINE_DOCUMENT_PATH,
        body,
      }),
    },
    body,
  });
}

function route() {
  const publicFetch = vi.fn(async (input: { kind: string; url: string }) =>
    input.kind === "robots"
      ? {
          url: input.url,
          status: 200,
          contentType: "text/plain",
          text: "User-agent: *\nAllow: /\nCrawl-delay: 0",
          capturedAt: new Date().toISOString(),
          retryAfterSeconds: null,
        }
      : {
          url: input.url,
          status: 200,
          contentType: "text/html",
          text: "<html><head><title>Reserve Red</title></head><body><article>Grounded synthetic wine document.</article></body></html>",
          capturedAt: new Date().toISOString(),
          retryAfterSeconds: null,
        },
  );
  return {
    publicFetch,
    post: createWineEvidenceDocumentPost({
      getDatabase: () => database,
      secret: () => secret,
      publicFetch,
      wait: async () => {},
    }),
  };
}

describe("wine evidence document route with durable store", () => {
  it("claims, fetches, finishes and replays the persisted terminal result without refetching", async () => {
    const f = await fixture();
    const r = route();
    const first = await r.post(await signedRequest(f.request));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      status: "completed",
      result: {
        workspaceId: f.workspaceId,
        runId: f.run.id,
        sourceId: f.source.id,
        state: "ready",
        extractEligible: true,
      },
    });
    expect(r.publicFetch).toHaveBeenCalledTimes(2);

    const replay = await r.post(await signedRequest(f.request));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(r.publicFetch).toHaveBeenCalledTimes(2);
  });

  it("returns stale or unknown without fetch for foreign, revision, cancellation and deadline fences", async () => {
    const r = route();
    const foreign = await fixture();
    const otherWorkspace = await fixture();
    const foreignResponse = await r.post(
      await signedRequest({
        ...foreign.request,
        sourceId: otherWorkspace.source.id,
      }),
    );
    expect(foreignResponse.status).toBe(409);
    expect(await foreignResponse.json()).toEqual({ status: "stale" });

    const revision = await fixture();
    await admin`update listing_drafts set input_revision=1 where workspace_id=${revision.workspaceId} and id=${revision.listing.id}`;
    expect(
      await (await r.post(await signedRequest(revision.request))).json(),
    ).toEqual({ status: "stale" });

    const cancelled = await fixture();
    await database.forWorkspace(cancelled.workspaceId, (repos) =>
      repos.pipelineRuns.setOperationState(cancelled.run.id, "cancelled"),
    );
    expect(
      await (await r.post(await signedRequest(cancelled.request))).json(),
    ).toEqual({ status: "stale" });

    const expired = await fixture({
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(
      await (await r.post(await signedRequest(expired.request))).json(),
    ).toEqual({ status: "stale" });

    const unknown = await fixture();
    expect(
      await createWineDocumentStore(database).claim(
        unknown.request,
        new Date().toISOString(),
      ),
    ).toMatchObject({ state: "claimed" });
    expect(
      await (await r.post(await signedRequest(unknown.request))).json(),
    ).toEqual({ status: "unknown" });
    expect(r.publicFetch).not.toHaveBeenCalled();
  });
});

it.each(["full", "research", "copy", "section"])(
  "never fetches documents under empty-domain %s policy",
  async (wineMode) => {
    const f = await fixture({ wineMode, allowedDomains: [] });
    const r = route();
    expect(await (await r.post(await signedRequest(f.request))).json()).toEqual(
      { status: "stale" },
    );
    expect(r.publicFetch).not.toHaveBeenCalled();
  },
);
it.each(["copy", "section", "unknown"])(
  "never fetches documents for non-research mode %s",
  async (wineMode) => {
    const f = await fixture({ wineMode });
    const r = route();
    expect(await (await r.post(await signedRequest(f.request))).json()).toEqual(
      { status: "stale" },
    );
    expect(r.publicFetch).not.toHaveBeenCalled();
  },
);

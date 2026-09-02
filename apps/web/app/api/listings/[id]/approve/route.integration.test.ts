import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "@wukong/db";

import { createApproveListingHandler } from "./route.js";

// This suite exists specifically to catch a class of bug that the
// fake-repository unit tests in `route.test.ts` structurally cannot catch:
// `route.test.ts`'s fake `forWorkspace` just invokes the callback directly,
// with no BEGIN/COMMIT/ROLLBACK simulation at all. The Phase-0 rejection
// branches below (version_conflict, confirmation_ledger_stale, and the
// freshness-gate failure) write an audit event and then reject -- and
// `db.forWorkspace` (packages/db/src/client.ts) wraps that whole callback in
// a real `drizzleClient.transaction(...)`. If the route ever throws the
// `ApiError` from *inside* that same callback again (the original bug this
// suite guards against), postgres-js issues a real ROLLBACK and the audit
// write never reaches the database, even though the HTTP response still
// reports the correct 409 -- a fake repository has no rollback to lose that
// write to, so only a real-Postgres assertion can catch it.
const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const workspaceId = "ws_approve_audit_fix";

const listingContent: CanonicalListing = {
  sku: "OPAK-001",
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: 4,
  criticScores: [],
  awards: [],
  title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: {
    title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
    description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  },
  tags: ["Riesling"],
  imageAssetIds: [],
};

function routeRequest(
  listingId: string,
  body: Record<string, unknown>,
): Request {
  return new Request(`http://localhost/api/listings/${listingId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext(listingId: string) {
  return { params: Promise.resolve({ id: listingId }) };
}

describe("POST /api/listings/[id]/approve (live Postgres)", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  const handler = createApproveListingHandler({
    sessionContext: {
      async resolve() {
        return {
          workspaceId,
          actorId: "test:approve-audit-fix",
          role: "reviewer",
        };
      },
    },
    // The real, live-Postgres database -- not the fake used by
    // route.test.ts -- so `db.forWorkspace` really opens a
    // `drizzleClient.transaction(...)` and really rolls it back on throw.
    getDatabase: () => database,
  });

  beforeAll(async () => {
    await admin.unsafe(
      "DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;",
    );
    await database.migrate();
    await admin.unsafe(`DELETE FROM workspaces WHERE id = '${workspaceId}'`);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  async function seedInReview(): Promise<{
    listingId: string;
    activeVersionId: string;
  }> {
    const created = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const version = await repos.listings.appendVersion(
        listing.id,
        listingContent,
        {
          workspaceId,
          actorId: "test:approve-audit-fix",
          entityId: listing.id,
        },
        repos.audit,
      );
      return { listingId: listing.id, versionId: version.id };
    });
    await admin`update listing_drafts set status = 'in_review', active_version_id = ${created.versionId} where workspace_id = ${workspaceId} and id = ${created.listingId}`;
    return { listingId: created.listingId, activeVersionId: created.versionId };
  }

  it("commits the listing.review_conflict audit write even though the version_conflict rejection rolls the rest of the phase-0 transaction back", async () => {
    const { listingId } = await seedInReview();
    const mismatchedVersionId = "00000000-0000-4000-8000-000000000999";

    const response = await handler(
      routeRequest(listingId, {
        expectedVersionId: mismatchedVersionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(listingId),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "version_conflict",
    });

    // The assertion that would have caught the original bug: a SEPARATE,
    // fresh `forWorkspace` call -- a brand new transaction, reusing
    // nothing from the request above -- reading back what is actually
    // durable in Postgres. If the fix regresses and the ApiError is once
    // again thrown from inside the same transaction as the audit write,
    // this query comes back empty even though the response above still
    // correctly reports 409 version_conflict.
    const events = await forWorkspace(database, workspaceId, (repos) =>
      repos.audit.findRelatedToListing(listingId),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "listing.review_conflict",
        entityId: listingId,
        metadata: { reason: "version_conflict" },
      }),
    );
  });
});

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";
import type { ShotCandidate } from "@wukong/core";
import { verifyAudit } from "../cli/audit-verify.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error("Explicit isolated test database URLs required");
const admin = postgres(adminUrl, {
  max: 3,
  prepare: false,
  onnotice: () => {},
});
const app = postgres(appUrl, { max: 3, prepare: false, onnotice: () => {} });
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const digest = (letter = "a") => letter.repeat(64);

beforeAll(async () => {
  expect((await admin`select 1 as connected`)[0]!.connected).toBe(1);
  const [role] =
    await app`select rolsuper, rolbypassrls from pg_roles where rolname=current_user`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  await db.migrate();
});
afterAll(async () => {
  await db.close();
  await app.end();
  await admin.end();
});

async function fixture(workspaceId = "shot_" + randomUUID()) {
  const listingId = randomUUID(),
    versionId = randomUUID(),
    actorId = workspaceId + "_reviewer";
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic','{}') on conflict do nothing`;
  await admin`insert into users(id,email) values (${actorId},${actorId + "@example.invalid"}) on conflict do nothing`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${workspaceId},${actorId},'reviewer') on conflict do nothing`;
  await admin`insert into listing_drafts(id,workspace_id,status) values (${listingId},${workspaceId},'in_review')`;
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${versionId},${workspaceId},${listingId},1,'{"imageAssetIds":[]}',${actorId})`;
  await admin`update listing_drafts set active_version_id=${versionId} where id=${listingId}`;
  const sourceAssetId = await asset(workspaceId, listingId, "image/jpeg", {
    size: 100,
    mimeType: "image/jpeg",
  });
  const identity = {
    workspaceId,
    listingId,
    sourceAssetId,
    sourceDigest: digest(),
    providerVersion: "photoroom-v1",
    renderVersion: "white-v1",
  };
  const ensure = (explicitFreshAttempt = false) =>
    db.forWorkspace(workspaceId, (r) =>
      r.productShots.ensure({ ...identity, actorId, explicitFreshAttempt }),
    );
  const get = (attemptId: string) =>
    db.forWorkspace(workspaceId, (r) => r.productShots.get(attemptId));
  return { ...identity, identity, actorId, versionId, ensure, get };
}
async function asset(
  workspaceId: string,
  listingId: string | null,
  kind: string,
  metadata: Record<string, unknown>,
) {
  const id = randomUUID();
  await admin`insert into source_assets(id,workspace_id,listing_id,storage_key,kind,metadata) values (${id},${workspaceId},${listingId},${workspaceId + "/" + id},${kind},${admin.json(metadata as never)})`;
  return id;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const claim = (
  f: Fixture,
  attemptId: string,
  dailyLimit = 5,
  now = new Date(),
) =>
  db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.claim({ attemptId, dailyLimit, now }),
  );
async function cutout(f: Fixture, attemptId: string, leaseToken: string) {
  const assetId = await asset(f.workspaceId, f.listingId, "image/png", {
    role: "product_shot_cutout",
    attemptId,
    sourceAssetId: f.sourceAssetId,
    sourceDigest: f.sourceDigest,
    providerVersion: f.providerVersion,
    renderVersion: f.renderVersion,
    digest: digest("b"),
    mimeType: "image/png",
    size: 100,
  });
  await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.saveCutout({ attemptId, leaseToken, assetId }),
  );
  return assetId;
}
async function candidate(
  f: Fixture,
  attemptId: string,
  overrides: Record<string, unknown> = {},
) {
  const data = {
    digest: digest("c"),
    width: 1600,
    height: 1600,
    size: 1000,
    lowResolution: false,
  };
  const assetId = await asset(f.workspaceId, f.listingId, "image/jpeg", {
    role: "product_shot_candidate",
    attemptId,
    sourceAssetId: f.sourceAssetId,
    sourceDigest: f.sourceDigest,
    providerVersion: f.providerVersion,
    renderVersion: f.renderVersion,
    mimeType: "image/jpeg",
    ...data,
    ...overrides,
  });
  return { assetId, ...data } satisfies ShotCandidate;
}
async function ready(f: Fixture) {
  const { attemptId } = await f.ensure();
  const c = await claim(f, attemptId);
  if (c.kind !== "claimed") throw new Error("fixture claim failed");
  await cutout(f, attemptId, c.leaseToken);
  const image = await candidate(f, attemptId);
  await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.saveCandidate({ attemptId, candidate: image }),
  );
  const observation = {
    attemptId,
    expectedVersionId: f.versionId,
    candidateDigest: image.digest,
    actorId: f.actorId,
  };
  return { attemptId, image, observation };
}

describe("durable product shots", () => {
  it("deduplicates concurrent requests and persists one current selection and request audit", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.ensure(), f.ensure()]);
    expect(a).toEqual(b);
    expect(await f.get(a!.attemptId)).toMatchObject({
      ...f.identity,
      state: "queued",
      generation: 1,
      candidate: null,
    });
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.currentForListing(f.listingId),
      ),
    ).toMatchObject({ attemptId: a!.attemptId });
    expect(
      await admin`select * from audit_events where entity_id=${f.listingId} and action='product_shot.requested'`,
    ).toHaveLength(1);
  });
  it("claims once across separate transactions and counts exactly one dispatch", async () => {
    const f = await fixture(),
      { attemptId } = await f.ensure();
    const claimSameAttempt = () => claim(f, attemptId);
    const countDispatchedForSyntheticWorkspace = async () =>
      Number(
        (
          await admin`select count(*) n from product_shot_attempts where workspace_id=${f.workspaceId} and dispatched_at is not null`
        )[0]!.n,
      );
    const claims = await Promise.all([claimSameAttempt(), claimSameAttempt()]);
    expect(claims.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(await countDispatchedForSyntheticWorkspace()).toBe(1);
    expect(
      (
        await admin`select dispatched_count from product_shot_daily_dispatches where workspace_id=${f.workspaceId}`
      )[0]!.dispatched_count,
    ).toBe(1);
  });
  it("enforces an atomic workspace budget across different listings and fails closed without an allowance", async () => {
    const f = await fixture(),
      g = await fixture(f.workspaceId);
    const a = await f.ensure(),
      b = await g.ensure();
    expect(await claim(f, a.attemptId, 0)).toEqual({
      kind: "budget_exhausted",
    });
    const results = await Promise.all([
      claim(f, a.attemptId, 1),
      claim(g, b.attemptId, 1),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      "budget_exhausted",
      "claimed",
    ]);
    expect(
      await admin`select * from audit_events where workspace_id=${f.workspaceId} and action='product_shot.dispatched'`,
    ).toHaveLength(1);
  });
  it("turns expired dispatched leases into outcome_unknown, retaining budget and requiring explicit fresh attempt", async () => {
    const f = await fixture(),
      a = await f.ensure();
    const now = new Date(Date.now() - 60 * 60 * 1000);
    expect((await claim(f, a.attemptId, 1, now)).kind).toBe("claimed");
    expect(await claim(f, a.attemptId, 1)).toEqual({ kind: "outcome_unknown" });
    expect(await f.ensure()).toEqual(a);
    expect(await f.get(a.attemptId)).toMatchObject({
      state: "outcome_unknown",
      callCount: 1,
    });
    const fresh = await f.ensure(true);
    expect(fresh.attemptId).not.toBe(a.attemptId);
    expect(await f.get(fresh.attemptId)).toMatchObject({ generation: 2 });
    expect(await claim(f, fresh.attemptId, 1)).toEqual({
      kind: "budget_exhausted",
    });
  });
  it("rejects foreign, unattached, wrong-listing and non-image input assets", async () => {
    const f = await fixture(),
      other = await fixture(),
      sameWorkspace = await fixture(f.workspaceId);
    for (const sourceAssetId of [
      other.sourceAssetId,
      sameWorkspace.sourceAssetId,
      await asset(f.workspaceId, null, "image/jpeg", {}),
      await asset(f.workspaceId, f.listingId, "application/pdf", {}),
    ]) {
      await expect(
        db.forWorkspace(f.workspaceId, (r) =>
          r.productShots.ensure({
            ...f.identity,
            sourceAssetId,
            actorId: f.actorId,
            explicitFreshAttempt: false,
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      db.forWorkspace(other.workspaceId, (r) =>
        r.productShots.ensure({
          ...f.identity,
          actorId: f.actorId,
          explicitFreshAttempt: false,
        }),
      ),
    ).rejects.toThrow();
  });
  it("checks lease and output asset binding then reuses durable cutout without another dispatch", async () => {
    const f = await fixture(),
      a = await f.ensure(),
      c = await claim(f, a.attemptId);
    if (c.kind !== "claimed") throw new Error("claim failed");
    const foreign = await fixture();
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.saveCutout({
          attemptId: a.attemptId,
          leaseToken: c.leaseToken,
          assetId: foreign.sourceAssetId,
        }),
      ),
    ).rejects.toThrow();
    await expect(cutout(f, a.attemptId, randomUUID())).rejects.toThrow();
    const saved = await cutout(f, a.attemptId, c.leaseToken);
    expect(await f.get(a.attemptId)).toMatchObject({
      state: "cutout_ready",
      cutoutAssetId: saved,
      cutoutDigest: digest("b"),
    });
    expect(await claim(f, a.attemptId)).toEqual({ kind: "skip" });
    expect(await f.ensure()).toEqual(a);
  });
  it("rejects candidate source/render/digest tampering and treats saved candidate as immutable", async () => {
    const f = await fixture(),
      a = await f.ensure(),
      c = await claim(f, a.attemptId);
    if (c.kind !== "claimed") throw new Error("claim failed");
    await cutout(f, a.attemptId, c.leaseToken);
    for (const change of [
      { sourceAssetId: randomUUID() },
      { renderVersion: "foreign" },
      { digest: digest("d") },
      { attemptId: randomUUID() },
    ]) {
      const image = await candidate(f, a.attemptId, change);
      await expect(
        db.forWorkspace(f.workspaceId, (r) =>
          r.productShots.saveCandidate({
            attemptId: a.attemptId,
            candidate: image,
          }),
        ),
      ).rejects.toThrow();
    }
    const image = await candidate(f, a.attemptId);
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.saveCandidate({
        attemptId: a.attemptId,
        candidate: image,
      }),
    );
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.saveCandidate({
        attemptId: a.attemptId,
        candidate: image,
      }),
    );
    const replacement = await candidate(f, a.attemptId);
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.saveCandidate({
          attemptId: a.attemptId,
          candidate: replacement,
        }),
      ),
    ).rejects.toThrow();
  });
  it("source replacement blocks old claim, candidate and approval without revoking historical publication", async () => {
    const f = await fixture(),
      old = await ready(f);
    const published = await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.approve(old.observation),
    );
    const newSource = await asset(f.workspaceId, f.listingId, "image/jpeg", {});
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.ensure({
        ...f.identity,
        sourceAssetId: newSource,
        actorId: f.actorId,
        explicitFreshAttempt: false,
      }),
    );
    expect(await claim(f, old.attemptId)).toEqual({ kind: "skip" });
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.saveCandidate({
          attemptId: old.attemptId,
          candidate: old.image,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.approve(old.observation),
      ),
    ).rejects.toThrow();
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.approvedForAsset({
          listingId: f.listingId,
          versionId: f.versionId,
          assetId: old.image.assetId,
        }),
      ),
    ).toMatchObject({ publicationToken: published.publicationToken });
    expect(
      await admin`select * from audit_events where entity_id=${f.listingId} and action='product_shot.source_replaced'`,
    ).toHaveLength(1);
  });
  it("rejects stale observations, preserves factual status and approves idempotently with pinned immutable bytes", async () => {
    const f = await fixture(),
      shot = await ready(f);
    for (const mismatch of [
      { expectedVersionId: randomUUID() },
      { candidateDigest: digest("d") },
    ]) {
      await expect(
        db.forWorkspace(f.workspaceId, (r) =>
          r.productShots.approve({ ...shot.observation, ...mismatch }),
        ),
      ).rejects.toThrow();
    }
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        db.forWorkspace(f.workspaceId, (r) =>
          r.productShots.approve(shot.observation),
        ),
      ),
    );
    expect(a).toEqual(b);
    expect(a!.publicationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await admin`select status from listing_drafts where id=${f.listingId}`
      )[0]!.status,
    ).toBe("in_review");
    await expect(
      admin`delete from source_assets where id=${shot.image.assetId}`,
    ).rejects.toThrow();
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${f.workspaceId},true)`;
        await tx`update product_shot_publications set candidate_digest=${digest("d")} where token=${a!.publicationToken}`;
      }),
    ).rejects.toThrow();
  });
  it("binds only a factual-approved active version containing the exact image and preserves version URLs", async () => {
    const f = await fixture(),
      shot = await ready(f);
    const original = await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.approve(shot.observation),
    );
    const versionId = randomUUID();
    await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${versionId},${f.workspaceId},${f.listingId},2,${admin.json({ imageAssetIds: [shot.image.assetId] })},${f.actorId})`;
    const binding = {
      ...original,
      expectedVersionId: f.versionId,
      versionId,
      actorId: f.actorId,
    };
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.bindApprovedVersion(binding),
      ),
    ).rejects.toThrow();
    const promoted = await db.forWorkspace(f.workspaceId, async (r) => {
      await r.listings.lockReviewState(f.listingId);
      await r.listings.promoteAndApprove(
        f.listingId,
        f.versionId,
        versionId,
        {
          workspaceId: f.workspaceId,
          actorId: f.actorId,
          entityId: f.listingId,
        },
        r.audit,
      );
      return r.productShots.bindApprovedVersion(binding);
    });
    expect(promoted.publicationToken).not.toBe(original.publicationToken);
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.bindApprovedVersion(binding),
      ),
    ).toEqual(promoted);
    for (const [id, publicationToken] of [
      [f.versionId, original.publicationToken],
      [versionId, promoted.publicationToken],
    ]) {
      expect(
        await db.forWorkspace(f.workspaceId, (r) =>
          r.productShots.approvedForAsset({
            listingId: f.listingId,
            versionId: id!,
            assetId: shot.image.assetId,
          }),
        ),
      ).toMatchObject({ publicationToken });
    }
  });
  it("revokes explicitly, cannot revive an old token by reapproval, and isolates all reads and audits", async () => {
    const f = await fixture(),
      other = await fixture(),
      shot = await ready(f);
    const published = await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.approve(shot.observation),
    );
    expect(
      await db.forWorkspace(other.workspaceId, (r) =>
        r.productShots.get(shot.attemptId),
      ),
    ).toBeNull();
    expect(
      await db.forWorkspace(other.workspaceId, (r) =>
        r.productShots.currentForListing(f.listingId),
      ),
    ).toBeNull();
    await expect(
      db.forWorkspace(other.workspaceId, (r) =>
        r.productShots.revoke({ ...published, actorId: other.actorId }),
      ),
    ).rejects.toThrow();
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.revoke({ ...published, actorId: f.actorId }),
    );
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.approvedForAsset({
          listingId: f.listingId,
          versionId: f.versionId,
          assetId: shot.image.assetId,
        }),
      ),
    ).toBeNull();
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.approve(shot.observation),
      ),
    ).rejects.toThrow();
    const result = await verifyAudit({
      workspaceId: f.workspaceId,
      draftId: f.listingId,
      url: appUrl!,
    });
    expect(result.accessibleForeignRecordCount).toBe(0);
    expect(
      result.missingActions.filter((action) =>
        action.startsWith("product_shot."),
      ),
    ).toEqual([]);
  });
  it("sanitizes failure codes, prevents automatic retry and writes mutation audits transactionally", async () => {
    const f = await fixture(),
      a = await f.ensure(),
      c = await claim(f, a.attemptId);
    if (c.kind !== "claimed") throw new Error("claim failed");
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.finishFailure({
          attemptId: a.attemptId,
          leaseToken: randomUUID(),
          code: "rejected",
          unknown: false,
        }),
      ),
    ).rejects.toThrow();
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.finishFailure({
        attemptId: a.attemptId,
        leaseToken: c.leaseToken,
        code: "https://private.example/secret",
        unknown: false,
      }),
    );
    expect(await f.get(a.attemptId)).toMatchObject({
      state: "failed",
      errorCode: "processing_failed",
    });
    expect(await claim(f, a.attemptId)).toEqual({ kind: "skip" });
    const g = await fixture();
    await expect(
      db.forWorkspace(g.workspaceId, async (r) => {
        await r.productShots.ensure({
          ...g.identity,
          actorId: g.actorId,
          explicitFreshAttempt: false,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await admin`select * from product_shot_attempts where workspace_id=${g.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await admin`select * from audit_events where workspace_id=${g.workspaceId}`,
    ).toHaveLength(0);
  });
});

it("pins referenced asset metadata and storage identity and rejects incomplete SQL candidate records", async () => {
  const f = await fixture(),
    shot = await ready(f);
  const published = await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.approve(shot.observation),
  );
  const [assetRow] =
    await admin`select storage_key from source_assets where id=${shot.image.assetId}`;
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.approvedForAsset({
        listingId: f.listingId,
        versionId: f.versionId,
        assetId: shot.image.assetId,
      }),
    ),
  ).toMatchObject({ storageKey: assetRow!.storage_key });
  await expect(
    admin`update source_assets set storage_key=${f.workspaceId + "/changed"} where id=${shot.image.assetId}`,
  ).rejects.toThrow("immutable");
  await expect(
    admin`update source_assets set metadata='{}' where id=${f.sourceAssetId}`,
  ).rejects.toThrow("immutable");
  await expect(
    admin`update product_shot_attempts set candidate_width=null where id=${shot.attemptId}`,
  ).rejects.toThrow();
  await expect(
    admin`update product_shot_publications set token=${digest("e")} where token=${published.publicationToken}`,
  ).rejects.toThrow("immutable");
});

it("denies viewer mutations, operator image approval, foreign output SQL and unscoped tenant reads", async () => {
  const f = await fixture(),
    other = await fixture(),
    shot = await ready(f);
  for (const role of ["viewer", "operator"]) {
    const actorId = f.workspaceId + "_" + role;
    await admin`insert into users(id,email) values (${actorId},${actorId + "@example.invalid"})`;
    await admin`insert into memberships(workspace_id,user_id,role) values (${f.workspaceId},${actorId},${role})`;
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        r.productShots.approve({ ...shot.observation, actorId }),
      ),
    ).rejects.toThrow("reviewer_role_required");
    if (role === "viewer")
      await expect(
        db.forWorkspace(f.workspaceId, (r) =>
          r.productShots.ensure({
            ...f.identity,
            actorId,
            explicitFreshAttempt: false,
          }),
        ),
      ).rejects.toThrow("operator_role_required");
  }
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${f.workspaceId},true)`;
      await tx`update product_shot_attempts set candidate_asset_id=${other.sourceAssetId} where id=${shot.attemptId}`;
    }),
  ).rejects.toThrow();
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${other.workspaceId},true)`;
      await tx`insert into product_shot_selections(workspace_id,listing_id,attempt_id) values (${other.workspaceId},${other.listingId},${shot.attemptId})`;
    }),
  ).rejects.toThrow();
  for (const table of [
    "product_shot_attempts",
    "product_shot_selections",
    "product_shot_daily_dispatches",
    "product_shot_publications",
  ]) {
    expect(await app.unsafe(`select * from ${table}`)).toHaveLength(0);
    const [policy] =
      await admin`select relrowsecurity,relforcerowsecurity from pg_class where relname=${table}`;
    expect(policy).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  }
});

it("the database audit verifier detects a missing checkpoint on this specific attempt", async () => {
  const f = await fixture(),
    shot = await ready(f);
  await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.approve(shot.observation),
  );
  await admin`delete from audit_events where entity_id=${f.listingId} and action='product_shot.cutout_saved'`;
  const result = await verifyAudit({
    workspaceId: f.workspaceId,
    draftId: f.listingId,
    url: appUrl!,
  });
  expect(result.missingActions).toContain(
    "product_shot.cutout_saved:" + shot.attemptId,
  );
  expect(result.accessibleForeignRecordCount).toBe(0);
});

it("checkpoints a matching in-flight lease after source replacement without selecting or publishing the old image", async () => {
  const f = await fixture(),
    old = await f.ensure(),
    c = await claim(f, old.attemptId);
  if (c.kind !== "claimed") throw new Error("claim failed");
  const sourceAssetId = await asset(
    f.workspaceId,
    f.listingId,
    "image/jpeg",
    {},
  );
  const replacement = await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.ensure({
      ...f.identity,
      sourceAssetId,
      actorId: f.actorId,
      explicitFreshAttempt: false,
    }),
  );
  await cutout(f, old.attemptId, c.leaseToken);
  expect(await f.get(old.attemptId)).toMatchObject({ state: "cutout_ready" });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.currentForListing(f.listingId),
    ),
  ).toMatchObject({ attemptId: replacement.attemptId });
  const image = await candidate(f, old.attemptId);
  await expect(
    db.forWorkspace(f.workspaceId, (r) =>
      r.productShots.saveCandidate({
        attemptId: old.attemptId,
        candidate: image,
      }),
    ),
  ).rejects.toThrow("source_replaced");
});

it("rejects a promoted version missing the exact candidate and rolls factual promotion back with image binding", async () => {
  const f = await fixture(),
    shot = await ready(f);
  const publication = await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.approve(shot.observation),
  );
  const versionId = randomUUID();
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${versionId},${f.workspaceId},${f.listingId},2,${admin.json({ imageAssetIds: [f.sourceAssetId] })},${f.actorId})`;
  await expect(
    db.forWorkspace(f.workspaceId, async (r) => {
      await r.listings.lockReviewState(f.listingId);
      await r.listings.promoteAndApprove(
        f.listingId,
        f.versionId,
        versionId,
        {
          workspaceId: f.workspaceId,
          actorId: f.actorId,
          entityId: f.listingId,
        },
        r.audit,
      );
      await r.productShots.bindApprovedVersion({
        ...publication,
        expectedVersionId: f.versionId,
        versionId,
        actorId: f.actorId,
      });
    }),
  ).rejects.toThrow("approved_image_missing");
  expect(
    (
      await admin`select status,active_version_id from listing_drafts where id=${f.listingId}`
    )[0],
  ).toMatchObject({ status: "in_review", active_version_id: f.versionId });
  expect(
    await admin`select * from audit_events where entity_id=${f.listingId} and action='listing.approved'`,
  ).toHaveLength(0);
});

it("counts explicit unknown outcomes and trusted cost estimates while UTC budgets reset on a new day", async () => {
  const f = await fixture(),
    a = await f.ensure();
  const now = new Date();
  const c = await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.claim({
      attemptId: a.attemptId,
      dailyLimit: 1,
      now,
      estimatedCostUsd: 0.02,
    }),
  );
  if (c.kind !== "claimed") throw new Error("claim failed");
  await db.forWorkspace(f.workspaceId, (r) =>
    r.productShots.finishFailure({
      attemptId: a.attemptId,
      leaseToken: c.leaseToken,
      code: "outcome_unknown",
      unknown: true,
    }),
  );
  expect(await f.get(a.attemptId)).toMatchObject({
    state: "outcome_unknown",
    estimatedCostUsd: "0.020000",
    callCount: 1,
  });
  expect(await claim(f, a.attemptId)).toEqual({ kind: "outcome_unknown" });
  const fresh = await f.ensure(true);
  expect(await claim(f, fresh.attemptId, 1, now)).toEqual({
    kind: "budget_exhausted",
  });
  expect(
    (await claim(f, fresh.attemptId, 1, new Date(now.getTime() + 86400_000)))
      .kind,
  ).toBe("claimed");
});

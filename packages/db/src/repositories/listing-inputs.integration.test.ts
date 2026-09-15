import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase } from "../client.js";
const database = createDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
  {
    migrationUrl:
      process.env.TEST_DATABASE_ADMIN_URL ??
      "postgres://wukong:wukong@localhost:54329/wukong",
  },
);
const workspaceId = `inputs-${randomUUID()}`;
let listingId: string;
const context = () => ({
  workspaceId,
  actorId: "operator",
  entityId: listingId,
});
beforeAll(async () => {
  await database.migrate();
  listingId = await database.forWorkspace(
    workspaceId,
    async (r) => (await r.listings.create({ target: "shopline" })).id,
  );
});
afterAll(() => database.close());
describe("immutable listing inputs", () => {
  it("initializes source-only document, saves before a version, replays and fences concurrent editors", async () => {
    const initial = await database.forWorkspace(workspaceId, (r) =>
      r.listingInputs.initialize(
        { listingId, actorId: "operator" },
        context(),
        r.audit,
      ),
    );
    expect(initial.revision).toBe(1);
    const request = {
      listingId,
      actorId: "operator",
      expectedInputRevision: 1,
      baseVersionId: null,
      operationKey: randomUUID(),
      requestDigest: "a".repeat(64),
      changes: [{ field: "priceHkd" as const, value: 0 }],
    };
    const saved = await database.forWorkspace(workspaceId, (r) =>
      r.listingInputs.save(request, context(), r.audit),
    );
    expect(saved.revision).toBe(2);
    expect(saved.workingContent.priceHkd).toBe(0);
    expect(
      (
        await database.forWorkspace(workspaceId, (r) =>
          r.listingInputs.save(request, context(), r.audit),
        )
      ).revision,
    ).toBe(2);
    await expect(
      database.forWorkspace(workspaceId, (r) =>
        r.listingInputs.save(
          { ...request, requestDigest: "b".repeat(64) },
          context(),
          r.audit,
        ),
      ),
    ).rejects.toThrow("idempotency_conflict");
    const racers = await Promise.allSettled(
      [1, 2].map(() =>
        database.forWorkspace(workspaceId, (r) =>
          r.listingInputs.save(
            {
              ...request,
              expectedInputRevision: 2,
              operationKey: randomUUID(),
            },
            context(),
            r.audit,
          ),
        ),
      ),
    );
    expect(racers.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await database.forWorkspace(workspaceId, (r) =>
          r.listingInputs.getRevision(listingId, 1),
        )
      )?.workingContent.priceHkd,
    ).toBeNull();
    expect(
      await database.forWorkspace("foreign", (r) =>
        r.listingInputs.getCurrent(listingId),
      ),
    ).toBeNull();
  });
});

it("retains ordered typed sources and never steals another listing's source", async () => {
  const ids = await database.forWorkspace(workspaceId, async (r) => {
    const other = await r.listings.create({ target: "shopline" });
    const assets = await Promise.all(
      ["a", "b", "c"].map((letter) =>
        r.sourceAssets.create({
          storageKey: `${workspaceId}/${randomUUID()}.png`,
          kind: "image/png",
          metadata: { size: 10, clientSha256: letter.repeat(64) },
        }),
      ),
    );
    await r.sourceAssets.attachToListing(other.id, [assets[2]!.id]);
    return assets.map((a) => a.id);
  });
  const current = (await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.getCurrent(listingId),
  ))!;
  const request = {
    listingId,
    actorId: "operator",
    expectedInputRevision: current.revision,
    baseVersionId: null,
    operationKey: randomUUID(),
    requestDigest: "c".repeat(64),
    changes: [],
    sources: [
      {
        assetId: ids[1]!,
        role: "back_label" as const,
        use: "reference_only" as const,
        hero: false,
      },
      {
        assetId: ids[0]!,
        role: "front_label" as const,
        use: "analyse" as const,
        hero: true,
      },
    ],
  };
  const saved = await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(request, context(), r.audit),
  );
  expect(saved.sources.map((s) => s.assetId)).toEqual([ids[1], ids[0]]);
  expect(saved.sources[0]?.use).toBe("reference_only");
  await expect(
    database.forWorkspace(workspaceId, (r) =>
      r.listingInputs.save(
        {
          ...request,
          expectedInputRevision: saved.revision,
          operationKey: randomUUID(),
          sources: [{ ...request.sources[0]!, assetId: ids[2]! }],
        },
        context(),
        r.audit,
      ),
    ),
  ).rejects.toThrow("source_not_found");
  const removed = await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(
      {
        ...request,
        expectedInputRevision: saved.revision,
        operationKey: randomUUID(),
        sources: [],
      },
      context(),
      r.audit,
    ),
  );
  expect(removed.sources).toEqual([]);
  expect(
    await database.forWorkspace(workspaceId, (r) =>
      r.sourceAssets.listForListing(listingId),
    ),
  ).toHaveLength(2);
  expect(
    (
      await database.forWorkspace(workspaceId, (r) =>
        r.listingInputs.getRevision(listingId, saved.revision),
      )
    )?.sources,
  ).toHaveLength(2);
});
it("rejects a stale nullable base even if input revision matches", async () => {
  const current = (await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.getCurrent(listingId),
  ))!;
  await expect(
    database.forWorkspace(workspaceId, (r) =>
      r.listingInputs.save(
        {
          listingId,
          actorId: "operator",
          expectedInputRevision: current.revision,
          baseVersionId: randomUUID(),
          operationKey: randomUUID(),
          requestDigest: "d".repeat(64),
          changes: [],
        },
        context(),
        r.audit,
      ),
    ),
  ).rejects.toThrow("base_version_conflict");
});
it("supersedes an active operation on correction and retains its pinned input", async () => {
  const current = (await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.getCurrent(listingId),
  ))!;
  const run = await database.forWorkspace(workspaceId, (r) =>
    r.pipelineRuns.acceptOperation({
      listingId,
      inputRevision: current.revision,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: "e".repeat(64),
      execution: { input: current },
    }),
  );
  await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId,
        actorId: "operator",
        expectedInputRevision: current.revision,
        baseVersionId: null,
        operationKey: randomUUID(),
        requestDigest: "f".repeat(64),
        changes: [{ field: "title.en", value: "Human correction" }],
      },
      context(),
      r.audit,
    ),
  );
  const retained = await database.forWorkspace(workspaceId, (r) =>
    r.pipelineRuns.getOperation(run.id),
  );
  expect(retained?.executionState).toBe("superseded");
  expect(retained?.inputRevision).toBe(current.revision);
});

it("accepts ten source images plus one supplier PDF", async () => {
  const created = await database.forWorkspace(workspaceId, async (r) => {
    const draft = await r.listings.create({ target: "shopline" });
    const selections = [];
    for (let index = 0; index < 11; index++) {
      const pdf = index === 10;
      const asset = await r.sourceAssets.create({
        storageKey: `${workspaceId}/${randomUUID()}`,
        kind: pdf ? "application/pdf" : "image/png",
        metadata: { size: 10, clientSha256: "a".repeat(64) },
      });
      selections.push({
        assetId: asset.id,
        role: pdf ? ("supplier_document" as const) : ("other_image" as const),
        use: "analyse" as const,
        hero: false,
      });
    }
    return r.listingInputs.initialize(
      { listingId: draft.id, actorId: "operator", sources: selections },
      { workspaceId, actorId: "operator", entityId: draft.id },
      r.audit,
    );
  });
  expect(created.sources).toHaveLength(11);
});

it("attributes explicitly supplied initial manual values without changing unknown facts", async () => {
  const result = await database.forWorkspace(workspaceId, async (r) => {
    const draft = await r.listings.create({ target: "shopline" });
    const { emptyWorkingListing } = await import("@wukong/core");
    return r.listingInputs.initialize(
      {
        listingId: draft.id,
        actorId: "operator",
        workingContent: {
          ...emptyWorkingListing(),
          producer: "Human producer",
        },
      },
      { workspaceId, actorId: "operator", entityId: draft.id },
      r.audit,
    );
  });
  expect(result.fieldStates.producer).toMatchObject({
    owner: "operator",
    state: "manual",
  });
  expect(result.workingContent.priceHkd).toBeNull();
});
it("snapshots generated review fields during source-note-only save without blanking them", async () => {
  const { emptyWorkingListing } = await import("@wukong/core");
  const f = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const audit = { workspaceId, actorId: "operator", entityId: listing.id };
    await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "operator" },
      audit,
      r.audit,
    );
    const text = { en: "Generated copy", "zh-Hant": "生成內容" };
    const version = await r.listings.promoteManual(
      listing.id,
      {
        ...emptyWorkingListing(),
        packQuantity: 1,
        title: text,
        description: text,
        seo: { title: text, description: text },
      },
      audit,
      r.audit,
      [],
    );
    return { listing, audit, version };
  });
  const saved = await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.listing.id,
        actorId: "operator",
        expectedInputRevision: 1,
        baseVersionId: f.version.id,
        operationKey: randomUUID(),
        requestDigest: "f".repeat(64),
        note: "A new source note",
        changes: [],
      },
      f.audit,
      r.audit,
    ),
  );
  expect(saved.workingContent.title.en).toBe("Generated copy");
  expect(saved.workingContent.description.en).toBe("Generated copy");
  expect(saved.note).toBe("A new source note");
  expect(saved.fieldStates["title.en"]?.state).toBe("proposed");
  expect(saved.workingContent.priceHkd).toBeNull();
  expect(
    (
      await database.forWorkspace(workspaceId, (r) =>
        r.listingInputs.getRevision(f.listing.id, 1),
      )
    )?.workingContent.title.en,
  ).toBe("");
});

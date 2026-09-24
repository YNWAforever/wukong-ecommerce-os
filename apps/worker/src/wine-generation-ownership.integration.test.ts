import { randomUUID } from "node:crypto";

import { createRequire } from "node:module";

import { afterAll, expect, it } from "vitest";

import {
  createDatabase,
  listingInputDigest,
  createWineEvidenceStore,
} from "@wukong/db";

import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  wineIdentity,
} from "@wukong/core";

import { WINE_EXECUTION_SNAPSHOT } from "@wukong/ai";

import { type WineListingJob, wineStageMessageKey } from "@wukong/jobs";

import { createWineStageStore } from "./wine-enrichment-runtime.js";

import {
  runWineStage,
  type WineStageResult,
} from "./wine-enrichment-pipeline.js";

const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");

const url = process.env.TEST_DATABASE_URL!;

if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw Error("dedicated fixture required");

const db = createDatabase(url);

const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});

afterAll(async () => {
  await db.close();

  await admin.end();
});

let observedAt = new Date().toISOString();

const extracted = (): WineStageResult => ({
  schemaVersion: 1,

  state: "succeeded",

  stage: "extraction",

  observedAt,

  identity: wineIdentity(),

  evidence: [],

  issues: [],
});

async function fixture(
  workingContent?: import("@wukong/core").WorkingListing,
  expired = false,
) {
  const workspaceId = `wine-stage-${randomUUID()}`;

  const run = await db.forWorkspace(workspaceId, async (r) => {
    const d = await r.listings.create({ target: "shopline" });

    const input = await r.listingInputs.initialize(
      { listingId: d.id, actorId: "test", workingContent },

      { workspaceId, actorId: "test", entityId: d.id },

      r.audit,
    );

    const acceptedAt = new Date(
      Date.parse(await r.pipelineRuns.acceptanceTimestamp()) -
        (expired ? 900001 : 0),
    ).toISOString();

    const run = await r.pipelineRuns.acceptOperation({
      listingId: d.id,

      inputRevision: input.revision,

      baseVersionId: null,

      activeVersionSequence: 0,

      requestKey: randomUUID(),

      requestDigest: randomUUID(),

      acceptedAt,

      execution: {
        schemaVersion: 1,

        flowVersion: "wine-enrichment-v1",

        input,

        wineInputDigest: input.inputDigest,

        wineSourceDigest: listingInputDigest(input.sources),

        wineMode: "full",

        wineBudget: createWineBudgetSnapshot("full"),

        wineGo: WINE_EXECUTION_SNAPSHOT,

        wineEnrichment: wineEnrichmentPolicySchema.parse({
          enabled: true,

          allowedDomains: ["wine.test"],

          tavilyCreditCap: 5,
        }),

        wineAcquisition: {
          schemaVersion: 1,

          policyVersion: "wine-enrichment@1",

          rulesVersion: "wine-grounding@1",

          allowedDomains: ["wine.test"],

          deadlineAt: new Date(Date.parse(acceptedAt) + 900000).toISOString(),
        },
      },
    });

    await r.aiBudgetReservations.reserve({
      pipelineRunId: run.id,

      reservedUsd: "3.194880",

      workspaceCapUsd: "10",

      pricingVersion: "wine-enrichment@1",
    });

    await r.searchBudgetReservations.reserve({
      pipelineRunId: run.id,

      reservedCredits: 5,

      workspaceCapCredits: 5,

      policyVersion: "wine-enrichment@1",
    });

    return run;
  });

  observedAt = run.acceptedAt;

  const job: WineListingJob = {
    schemaVersion: 2,

    flowVersion: "wine-enrichment-v1",

    workspaceId,

    draftId: run.listingId,

    runId: run.id,

    inputRevision: run.inputRevision,

    activeVersionSequence: 0,

    stage: "extraction",
  };

  return { run, job, store: createWineStageStore(db) };
}

import { emptyWorkingListing } from "@wukong/core";

import { readWineGenerationOwnership } from "./wine-generation-ownership.js";

it("distinguishes verified empty input from unavailable input and retains legacy operator metadata", async () => {
  const f = await fixture();
  const c = {
    schemaVersion: 1 as const,
    job: { ...f.job, stage: "generation" as const },
    run: f.run,
    dependencies: [],
    dependencyDigest: "unused",
  };

  const result = await readWineGenerationOwnership(db, c);

  expect(result).toMatchObject({
    status: "available",
    prior: { kind: "empty", current: null },
  });

  const legacy = {
    ...emptyWorkingListing(),
    description: { en: "Whole legacy", "zh-Hant": "完整舊文" },
    title: { en: "Human title", "zh-Hant": "人手標題" },
  };

  const l = await fixture(legacy);
  const lc = {
    ...c,
    job: { ...l.job, stage: "generation" as const },
    run: l.run,
  };

  expect(await readWineGenerationOwnership(db, lc)).toMatchObject({
    status: "available",
    prior: { kind: "legacy", current: null, description: legacy.description },
    lockedPaths: expect.arrayContaining(["title.en", "title.zh-Hant"]),
  });

  expect(
    await readWineGenerationOwnership(db, {
      ...lc,
      run: { ...l.run, baseVersionId: randomUUID() },
    }),
  ).toMatchObject({ status: "unavailable" });
});

it("rejects caller establishment of wine section ownership", async () => {
  const content = {
    ...emptyWorkingListing(),
    wineOwnership: { schemaVersion: 1 as const, sections: [] },
  };

  await expect(fixture(content)).rejects.toThrow("wine_ownership_server_only");
});

async function structuredFixture() {
  const f = await fixture();
  const content = {
    ...emptyWorkingListing(),
    packQuantity: 1,
    title: { en: "Title", "zh-Hant": "標題" },
    description: { en: "Original", "zh-Hant": "原文" },
    seo: {
      title: { en: "Title", "zh-Hant": "標題" },
      description: { en: "Description", "zh-Hant": "描述" },
    },
    wineOwnership: {
      schemaVersion: 1 as const,
      sections: [
        {
          key: "introduction" as const,
          en: "Original",
          "zh-Hant": "原文",
          claimIds: [],
          owner: "automatic" as const,
          locked: false,
        },
      ],
    },
  };
  const version = await db.forWorkspace(f.job.workspaceId, async (r) => {
    const audit = {
      workspaceId: f.job.workspaceId,
      actorId: "test",
      entityId: f.run.listingId,
    };
    await r.listings.startProcessing(f.run.listingId, audit, r.audit);
    const v = await r.listings.appendVersion(
      f.run.listingId,
      content,
      audit,
      r.audit,
    );
    await r.listings.complete(
      f.run.listingId,
      {
        status: "in_review",
        versionId: v.id,
        idempotencyKey: f.run.idempotencyKey,
      },
      audit,
      r.audit,
    );
    return v;
  });
  return { ...f, content, version };
}
it.each(["omitted", "whole"])(
  "preserves or invalidates mapping in actual input-save then editReview sequence: %s",
  async (mode) => {
    const f = await structuredFixture();
    const submitted = structuredClone(
      f.content,
    ) as import("@wukong/core").ReviewableListing;
    if (mode === "omitted") delete submitted.wineOwnership;
    else submitted.description.en = "Human whole";
    const result = await db.forWorkspace(f.job.workspaceId, async (r) => {
      const audit = {
        workspaceId: f.job.workspaceId,
        actorId: "test",
        entityId: f.run.listingId,
      };
      const saved = await r.listingInputs.save(
        {
          listingId: f.run.listingId,
          actorId: "test",
          expectedInputRevision: 1,
          baseVersionId: f.version.id,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          reviewContent: submitted,
          changes:
            mode === "whole"
              ? [{ field: "description.en", value: submitted.description.en }]
              : [],
        },
        audit,
        r.audit,
      );
      await r.listings.editReview(
        f.run.listingId,
        f.version.id,
        submitted,
        mode === "whole" ? ["description"] : [],
        audit,
        r.audit,
      );
      return {
        saved,
        review: await r.listings.getReviewSnapshot(f.run.listingId),
      };
    });
    for (const c of [
      result.saved.workingContent,
      result.review!.activeVersion!.content,
    ]) {
      expect(c.wineOwnership).toEqual(
        mode === "whole" ? undefined : f.content.wineOwnership,
      );
      expect(c.description.en).toBe(submitted.description.en);
    }
  },
);
it("persists section edits with revision and clears claims without accepting provenance", async () => {
  const f = await structuredFixture();
  const result = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.run.listingId,
        actorId: "test",
        expectedInputRevision: 1,
        baseVersionId: f.version.id,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [],
        sectionChanges: [
          { key: "introduction", en: "Human section", "zh-Hant": "人手段落" },
        ],
      },
      {
        workspaceId: f.job.workspaceId,
        actorId: "test",
        entityId: f.run.listingId,
      },
      r.audit,
    ),
  );
  expect(result.revision).toBe(2);
  expect(result.workingContent.wineOwnership?.sections[0]).toMatchObject({
    owner: "operator",
    en: "Human section",
    claimIds: [],
  });
  expect(result.inputDigest).not.toBe(f.run.execution.wineInputDigest);
});

it("reader rejects stale and forged coordinates and never equates missing input with empty", async () => {
  const f = await fixture();
  const c = {
    schemaVersion: 1 as const,
    job: { ...f.job, stage: "generation" as const },
    run: f.run,
    dependencies: [],
    dependencyDigest: "unused",
  };
  for (const changed of [
    { ...c, job: { ...c.job, workspaceId: "foreign" } },
    { ...c, run: { ...c.run, execution: { ...c.run.execution, input: {} } } },
    { ...c, job: { ...c.job, inputRevision: 2 } },
  ])
    expect(await readWineGenerationOwnership(db, changed)).toMatchObject({
      status: "unavailable",
    });
  const unavailable = {
    forWorkspace: ((workspaceId: string, callback: any) =>
      db.forWorkspace(workspaceId, (r) =>
        callback({
          ...r,
          listingInputs: { ...r.listingInputs, getRevision: async () => null },
        }),
      )) as typeof db.forWorkspace,
  };
  expect(await readWineGenerationOwnership(unavailable, c)).toMatchObject({
    status: "unavailable",
    code: "ownership_input_invalid",
  });
  await db.forWorkspace(f.job.workspaceId, (r) =>
    r.pipelineRuns.setOperationState(f.run.id, "cancelled"),
  );
  expect(await readWineGenerationOwnership(db, c)).toMatchObject({
    status: "unavailable",
    code: "ownership_operation_stale",
  });
});
it("manual promotion and review edits cannot mint or replace server provenance", async () => {
  const f = await structuredFixture();
  const forged = {
    ...f.content,
    wineOwnership: {
      ...f.content.wineOwnership,
      sections: [
        { ...f.content.wineOwnership.sections[0]!, owner: "operator" as const },
      ],
    },
  };
  await expect(
    db.forWorkspace(f.job.workspaceId, (r) =>
      r.listings.editReview(
        f.run.listingId,
        f.version.id,
        forged,
        [],
        {
          workspaceId: f.job.workspaceId,
          actorId: "test",
          entityId: f.run.listingId,
        },
        r.audit,
      ),
    ),
  ).rejects.toThrow("wine_ownership_server_only");
  const empty = await fixture();
  await expect(
    db.forWorkspace(empty.job.workspaceId, (r) =>
      r.listings.promoteManual(
        empty.run.listingId,
        f.content,
        {
          workspaceId: empty.job.workspaceId,
          actorId: "test",
          entityId: empty.run.listingId,
        },
        r.audit,
        [],
      ),
    ),
  ).rejects.toThrow("wine_ownership_server_only");
});

it("reader fences an actually expired accepted deadline", async () => {
  const f = await fixture(undefined, true);
  expect(
    await readWineGenerationOwnership(db, {
      schemaVersion: 1,
      job: f.job,
      run: f.run,
      dependencies: [],
      dependencyDigest: "unused",
    }),
  ).toMatchObject({ status: "unavailable", code: "ownership_deadline" });
});
it("reader derives structured content from exact active base and retains saved operator section", async () => {
  const f = await structuredFixture();
  const run = await db.forWorkspace(f.job.workspaceId, async (r) => {
    const audit = {
      workspaceId: f.job.workspaceId,
      actorId: "test",
      entityId: f.run.listingId,
    };
    const input = await r.listingInputs.save(
      {
        listingId: f.run.listingId,
        actorId: "test",
        expectedInputRevision: 1,
        baseVersionId: f.version.id,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [],
        sectionChanges: [
          { key: "introduction", en: "Owned", "zh-Hant": "Owned" },
        ],
      },
      audit,
      r.audit,
    );
    const acceptedAt = await r.pipelineRuns.acceptanceTimestamp();
    return r.pipelineRuns.acceptOperation({
      listingId: f.run.listingId,
      inputRevision: input.revision,
      baseVersionId: f.version.id,
      activeVersionSequence: f.version.sequence,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      acceptedAt,
      execution: {
        ...f.run.execution,
        input,
        wineInputDigest: input.inputDigest,
        wineAcquisition: {
          ...(f.run.execution.wineAcquisition as object),
          deadlineAt: new Date(Date.parse(acceptedAt) + 900000).toISOString(),
        },
      },
    });
  });
  const c = {
    schemaVersion: 1 as const,
    run,
    job: {
      ...f.job,
      runId: run.id,
      inputRevision: run.inputRevision,
      activeVersionSequence: run.activeVersionSequence,
    },
    dependencies: [],
    dependencyDigest: "unused",
  };
  expect(await readWineGenerationOwnership(db, c)).toMatchObject({
    status: "available",
    prior: {
      kind: "structured",
      current: {
        sections: [expect.objectContaining({ en: "Owned", owner: "operator" })],
      },
    },
    lockedPaths: ["sections.introduction"],
    provenance: { baseVersionId: f.version.id },
  });
});
it("reader preserves whole-description ownership on a structured legacy baseline", async () => {
  const f = await structuredFixture();
  const run = await db.forWorkspace(f.job.workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const audit = {
      workspaceId: f.job.workspaceId,
      actorId: "test",
      entityId: listing.id,
    };
    await r.listings.startProcessing(listing.id, audit, r.audit);
    const version = await r.listings.appendVersion(
      listing.id,
      f.content,
      audit,
      r.audit,
    );
    await r.listings.complete(
      listing.id,
      {
        status: "in_review",
        versionId: version.id,
        idempotencyKey: randomUUID(),
      },
      audit,
      r.audit,
    );
    const input = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "test" },
      audit,
      r.audit,
    );
    const acceptedAt = await r.pipelineRuns.acceptanceTimestamp();
    return r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: input.revision,
      baseVersionId: version.id,
      activeVersionSequence: version.sequence,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      acceptedAt,
      execution: {
        ...f.run.execution,
        input,
        wineInputDigest: input.inputDigest,
        wineSourceDigest: listingInputDigest(input.sources),
        wineAcquisition: {
          ...(f.run.execution.wineAcquisition as object),
          deadlineAt: new Date(Date.parse(acceptedAt) + 900000).toISOString(),
        },
      },
    });
  });
  expect(
    await readWineGenerationOwnership(db, {
      schemaVersion: 1,
      run,
      job: {
        ...f.job,
        draftId: run.listingId,
        runId: run.id,
        inputRevision: run.inputRevision,
        activeVersionSequence: run.activeVersionSequence,
      },
      dependencies: [],
      dependencyDigest: "unused",
    }),
  ).toMatchObject({
    status: "available",
    prior: { kind: "structured" },
    lockedPaths: expect.arrayContaining(["sections"]),
  });
});

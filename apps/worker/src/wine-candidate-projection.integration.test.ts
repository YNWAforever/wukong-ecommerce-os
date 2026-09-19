import { groundWineEvidence, decideWineClaim } from "@wukong/core";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect, it } from "vitest";
import { createDatabase, listingInputDigest } from "@wukong/db";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  wineIdentity,
  emptyWorkingListing,
  webEvidence,
} from "@wukong/core";
import { WINE_EXECUTION_SNAPSHOT } from "@wukong/ai";
import { type WineListingJob } from "@wukong/jobs";
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
async function fixture(
  workingContent?: import("@wukong/core").WorkingListing,
  baseContent?: import("@wukong/core").ReviewableListing,
  lockedUnknownPack = false,
  existing?: { workspaceId: string; listingId: string },
) {
  const workspaceId = existing?.workspaceId ?? `wine-stage-${randomUUID()}`;
  const run = await db.forWorkspace(workspaceId, async (r) => {
    const d = existing
      ? await r.listings.requireById(existing.listingId)
      : await r.listings.create({ target: "shopline" });
    let baseVersionId: string | null = d.activeVersionId;
    if (baseContent) {
      const audit = { workspaceId, actorId: "test", entityId: d.id };
      await r.listings.startProcessing(d.id, audit, r.audit);
      const v = await r.listings.appendVersion(
        d.id,
        baseContent,
        audit,
        r.audit,
      );
      baseVersionId = v.id;
      await r.listings.complete(
        d.id,
        { status: "in_review", versionId: v.id, idempotencyKey: randomUUID() },
        audit,
        r.audit,
      );
    }
    let input = await r.listingInputs.initialize(
      {
        listingId: d.id,
        actorId: "test",
        workingContent: baseContent ? undefined : workingContent,
        note: "Producer: Fixture Estate\nProduct: Reserve Red\nVolume: 750 ml\nPack quantity: 1 bottles\nMarket: HK",
      },
      { workspaceId, actorId: "test", entityId: d.id },
      r.audit,
    );
    if (lockedUnknownPack)
      input = await r.listingInputs.save(
        {
          listingId: d.id,
          actorId: "test",
          expectedInputRevision: input.revision,
          baseVersionId,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          changes: [
            {
              field: "packQuantity",
              value: null,
              state: "unknown",
              locked: true,
            },
          ],
        },
        { workspaceId, actorId: "test", entityId: d.id },
        r.audit,
      );
    const acceptedAt = new Date(
      Date.parse(await r.pipelineRuns.acceptanceTimestamp()),
    ).toISOString();
    const run = await r.pipelineRuns.acceptOperation({
      listingId: d.id,
      inputRevision: input.revision,
      baseVersionId,
      activeVersionSequence: (await r.listings.requireById(d.id))
        .activeVersionSequence,
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
        profile: { tone: "Clear", claimPolicy: [] },
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
  const job: WineListingJob = {
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    workspaceId,
    draftId: run.listingId,
    runId: run.id,
    inputRevision: run.inputRevision,
    activeVersionSequence: run.activeVersionSequence,
    stage: "extraction",
  };
  return { run, job, store: createWineStageStore(db) };
}

import { readWineGenerationOwnership } from "./wine-generation-ownership.js";
import { projectWineCandidate } from "./wine-candidate-projection.js";
import type { WineStageContext } from "./wine-enrichment-pipeline.js";
import type { WineContent } from "@wukong/core";

async function ready(
  working = emptyWorkingListing(),
  mutate: (result: WineStageResult) => WineStageResult = (r) => r,
  base?: import("@wukong/core").ReviewableListing,
  sourceAgeDays = 0,
  lockedUnknownPack = false,
  existing?: { workspaceId: string; listingId: string },
  reliable = false,
) {
  const f = await fixture(working, base, lockedUnknownPack, existing);
  const store = createWineStageStore(db, {
    projectCandidate: projectWineCandidate,
  });
  const binding = {
    workspaceId: f.job.workspaceId,
    operationId: f.run.id,
    inputRevision: f.run.inputRevision,
  };
  const input = f.run.execution
    .input as import("@wukong/db").ListingInputSnapshot;
  const sourceId = adoptedDb.wineExtractionSourceId(f.run.id, 0);
  const identity = wineIdentity({
    status: "matched",
    volumeMl: 750,
    packQuantity: 1,
  });
  identity.marketVariant = "HK";
  identity.observations.marketVariant = {
    value: "HK",
    state: "observed",
    evidenceIds: [sourceId],
  };
  for (const obs of Object.values(identity.observations))
    if (obs) obs.evidenceIds = [sourceId];
  const note = input.note!;
  const merchant = webEvidence({
    id: sourceId,
    kind: "merchant",
    url: null,
    domain: null,
    contentScope: "note",
    identity,
    excerpt: note,
    capturedAt: f.run.acceptedAt,
    trust: "unverified",
    documentDigest: "sha256:" + createHash("sha256").update(note).digest("hex"),
    location: `wine:extraction:${f.run.id}:transcript:0`,
    independenceKey: `merchant:${f.run.id}`,
  });
  const accepted = {
    binding,
    assets: [],
    note,
    lockedFields: Object.entries(input.fieldStates)
      .filter(([, v]) => v?.owner === "operator" || v?.locked)
      .map(([key]) => key),
    verifiedAliases: [],
  };
  const extractionGrounded = groundWineEvidence({
    accepted,
    extraction: { binding, identity },
    records: [
      {
        binding,
        assetDigest: null,
        documentDigest: merchant.documentDigest,
        source: merchant,
      },
    ],
    authorities: [],
    now: f.run.acceptedAt,
  }).context;
  const retained = [...extractionGrounded.sources];
  if (sourceAgeDays) {
    const reviewer = randomUUID();
    await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
    await admin`insert into memberships(workspace_id,user_id,role) values(${f.job.workspaceId},${reviewer},'reviewer')`;
    for (const domain of reliable
      ? ["wine.test", "reliable.test"]
      : ["wine.test"]) {
      const excerpt = `Kind: wine\n${note}\nABV: 13%\nPage: ${domain}`;
      retained.push(
        webEvidence({
          id: randomUUID(),
          domain,
          url: `https://${domain}/wine`,
          excerpt,
          capturedAt: new Date(
            Date.parse(f.run.acceptedAt) - sourceAgeDays * 86400000,
          ).toISOString(),
          identity: null,
          documentDigest:
            "sha256:" + createHash("sha256").update(excerpt).digest("hex"),
          independenceKey: domain,
        }),
      );
      await db.forWorkspace(f.job.workspaceId, (r) =>
        r.wineEnrichment.recordReviewedAuthority(reviewer, {
          schemaVersion: 1,
          domain,
          subject: reliable
            ? { kind: "reliable_source", name: domain }
            : { kind: "producer", name: "Fixture Estate" },
          proofUrl: `https://${domain}/about`,
          proofDigest: "a".repeat(64),
          verifiedAt: f.run.acceptedAt,
          expiresAt: new Date(
            Date.parse(f.run.acceptedAt) + (reliable ? 3600000 : 30 * 86400000),
          ).toISOString(),
          revokedAt: null,
          verifierId: reviewer,
        }),
      );
    }
  }
  const authorities = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.wineEnrichment.readAuthorities(),
  );
  const derived = groundWineEvidence({
    accepted,
    extraction: { binding, identity: extractionGrounded.identity },
    records: retained.map((source) => ({
      binding,
      assetDigest: null,
      documentDigest: source.documentDigest,
      source,
    })),
    authorities,
    now: f.run.acceptedAt,
  }).context;
  const claim = decideWineClaim({
    identity: derived.identity,
    claim: {
      id: randomUUID(),
      field: sourceAgeDays ? "abvPercent" : "producer",
      value: sourceAgeDays ? 13 : "Fixture Estate",
      kind: "fact",
      scope: "product",
      evidenceIds: retained
        .filter((s) => (sourceAgeDays ? s.kind === "web" : s.kind !== "web"))
        .map((s) => s.id),
      premiseClaimIds: [],
      state: "unknown",
      reason: "fixture",
    },
    sources: derived.sources,
    lockedFields: new Set(derived.lockedFields),
    context: {
      ...derived,
      reliableSourceIds: new Set(derived.reliableSourceIds),
      trustedObservationSourceIds: new Set(derived.trustedObservationSourceIds),
    },
  });
  const frozenVerification = {
    ...structuredClone(derived),
    acceptedPremises: [claim],
  };
  await db.forWorkspace(f.job.workspaceId, async (r) => {
    await r.wineEnrichment.saveEvidence(f.run.id, retained);
    await r.wineEnrichment.saveTrustedContext({
      runId: f.run.id,
      contextKey: adoptedDb.WINE_EXTRACTION_CONTEXT_KEY,
      inputDigest: input.inputDigest,
      context: {
        schemaVersion: 1,
        identity: extractionGrounded.identity,
        policyVersion: "wine-enrichment@1",
        authorities: extractionGrounded.authorities,
        supports: extractionGrounded.supports,
        reliableSourceIds: extractionGrounded.reliableSourceIds,
        trustedObservationSourceIds:
          extractionGrounded.trustedObservationSourceIds,
        acceptedPremises: extractionGrounded.acceptedPremises,
        verifiedAliases: extractionGrounded.verifiedAliases,
      },
    });
  });
  const source = sourceAgeDays ? retained[1]! : retained[0]!;
  const copy = sourceAgeDays ? "13% ABV" : "Fixture Estate";
  const content: WineContent = {
    title: { en: copy, "zh-Hant": copy },
    seo: {
      title: { en: copy, "zh-Hant": copy },
      description: { en: copy, "zh-Hant": copy },
    },
    tags: [],
    sections: [
      {
        key: "introduction",
        en: copy,
        "zh-Hant": copy,
        claimIds: [claim.id],
        locked: false,
        owner: "automatic",
      },
    ],
  };
  const execute = async (c: WineStageContext): Promise<WineStageResult> => {
    const common = {
      schemaVersion: 1 as const,
      state: "succeeded" as const,
      issues: [],
    };
    if (c.job.stage === "extraction")
      return {
        ...common,
        stage: "extraction",
        observedAt: f.run.acceptedAt,
        identity: extractionGrounded.identity,
        evidence: extractionGrounded.sources,
      };
    if (c.job.stage === "search_basic")
      return {
        ...common,
        stage: "search_basic",
        evidence: retained.filter((s) => s.kind === "web"),
        partial: false,
      };
    if (c.job.stage === "verification")
      return {
        ...common,
        stage: "verification",
        identity: derived.identity,
        claims: [claim],
        frozenVerification,
        needsDeepSearch: false,
        deepSearchReasons: [],
      };
    if (c.job.stage === "generation") {
      const own = await readWineGenerationOwnership(db, c);
      if (own.status !== "available") throw Error(own.code);
      if (existing && own.prior.current)
        content.sections = structuredClone(own.prior.current.sections);
      const request = {
        schemaVersion: 1 as const,
        binding,
        claims: [claim],
        current: own.prior.current,
        lockedPaths: own.lockedPaths,
        tone: "Clear",
        claimPolicy: [],
        section: null,
        ownership: {
          schemaVersion: 1 as const,
          priorKind: own.prior.kind,
          metadata: own.prior.metadata,
          legacyDescription:
            own.prior.kind === "legacy" ? own.prior.description : null,
          lockedPaths: own.lockedPaths,
          provenanceDigest: own.provenanceDigest,
        },
      };
      const annotations = [
        "title.en",
        "title.zh-Hant",
        "seo.title.en",
        "seo.title.zh-Hant",
        "seo.description.en",
        "seo.description.zh-Hant",
        "sections.introduction.en",
        "sections.introduction.zh-Hant",
      ]
        .filter((path) => !existing || !path.startsWith("sections."))
        .map((path) => ({
          path,
          span: copy,
          claimId: claim.id,
          value: claim.value,
          evidenceIds: claim.evidenceIds,
          premiseClaimIds: [],
        }));
      return {
        ...common,
        stage: "generation",
        content,
        frozenQuality: {
          schemaVersion: 1,
          request,
          candidate: { schemaVersion: 1, content, annotations },
        },
      };
    }
    return {
      ...common,
      stage: "quality_check",
      contentDigest: listingInputDigest(content),
      outcome: "ready",
    };
  };
  for (const stage of [
    "extraction",
    "search_basic",
    "verification",
    "generation",
    "quality_check",
  ] as const)
    expect(
      await runWineStage(
        { ...f.job, stage },
        { store, execute: async (c) => mutate(await execute(c)) },
      ),
    ).toMatchObject({ status: "advanced" });
  const claimed = await store.claim({ ...f.job, stage: "commit_candidate" });
  if (claimed.status !== "claimed") throw Error(JSON.stringify(claimed));
  return { ...f, store, context: claimed.context, content, claim, source };
}
it("projects a frozen candidate into the actual version and immutable section snapshot", async () => {
  const f = await ready();
  const result = await f.store.commitCandidate(f.context);
  expect(result).toMatchObject({ status: "completed", outcome: "complete" });
  if (result.status !== "completed" || !result.versionId)
    throw Error("version missing");
  await db.forWorkspace(f.job.workspaceId, async (r) => {
    const review = await r.listings.getReviewSnapshot(f.run.listingId);
    expect(review?.activeVersion?.id).toBe(result.versionId);
    expect(review?.activeVersion?.content.description).toEqual({
      en: "Fixture Estate",
      "zh-Hant": "Fixture Estate",
    });
    expect(review?.activeVersion?.content.producer).toBe("Fixture Estate");
    expect(
      await r.wineEnrichment.readSections(f.run.id, result.versionId!),
    ).toEqual(f.content);
  });
});
it("preserves an unstructured legacy description verbatim through real projection", async () => {
  const working = {
    ...emptyWorkingListing(),
    description: {
      en: "Original whole paragraph",
      "zh-Hant": "Legacy complete text",
    },
  };
  const f = await ready(working);
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "completed",
    outcome: "complete",
  });
  await db.forWorkspace(f.job.workspaceId, async (r) => {
    const review = await r.listings.getReviewSnapshot(f.run.listingId);
    expect(review?.activeVersion?.content.description).toEqual(
      working.description,
    );
    expect(review?.activeVersion?.content.wineOwnership).toBeUndefined();
    expect(
      await r.wineEnrichment.readSections(f.run.id, review!.activeVersion!.id),
    ).toEqual({ ...f.content, sections: [] });
  });
});

it("rolls back actual projection version, section snapshot and listing changes when section persistence throws (8aM1)", async () => {
  const f = await ready();
  const beforeOutbox =
    await admin`select count(*)::int n from listing_dispatch_outbox where workspace_id=${f.job.workspaceId}`;
  const beforeAudit =
    await admin`select count(*)::int n from audit_events where workspace_id=${f.job.workspaceId}`;
  const failing = {
    forWorkspace: async <T>(
      workspaceId: string,
      work: (r: import("@wukong/db").WorkspaceRepositories) => Promise<T>,
    ) =>
      db.forWorkspace(workspaceId, (r) =>
        work({
          ...r,
          wineEnrichment: {
            ...r.wineEnrichment,
            saveSections: async (input) => {
              await r.wineEnrichment.saveSections(input);
              throw Error("synthetic_projection_failure");
            },
          },
        }),
      ),
  };
  const store = createWineStageStore(failing, {
    projectCandidate: projectWineCandidate,
  });
  await expect(store.commitCandidate(f.context)).rejects.toThrow(
    "synthetic_projection_failure",
  );
  await db.forWorkspace(f.job.workspaceId, async (r) => {
    expect(
      (await r.wineEnrichment.readStage(f.run.id, "commit_candidate"))?.state,
    ).toBe("started");
    expect((await r.pipelineRuns.getOperation(f.run.id))?.executionState).toBe(
      "running",
    );
    expect(
      (await r.listings.getById(f.run.listingId))?.activeVersionId,
    ).toBeNull();
  });
  const rows =
    await admin`select count(*)::int count from listing_versions where workspace_id=${f.job.workspaceId} and listing_id=${f.run.listingId}`;
  expect(rows[0].count).toBe(0);
  const sections =
    await admin`select count(*)::int count from wine_section_snapshots where workspace_id=${f.job.workspaceId} and run_id=${f.run.id}`;
  expect(sections[0].count).toBe(0);
  expect(
    (
      await admin`select count(*)::int n from listing_dispatch_outbox where workspace_id=${f.job.workspaceId}`
    )[0].n,
  ).toBe(beforeOutbox[0].n);
  expect(
    (
      await admin`select count(*)::int n from audit_events where workspace_id=${f.job.workspaceId}`
    )[0].n,
  ).toBe(beforeAudit[0].n);
  expect(
    await f.store.claim({ ...f.job, stage: "commit_candidate" }),
  ).toMatchObject({ status: "blocked", code: "stage_outcome_unknown" });
  // Explicit test-only recovery retries the same transaction callback, never automatic Queue replay.
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "completed",
  });
});

it.each(["verification", "generation"])(
  "projection rejects absent frozen %s artifact",
  async (stage) => {
    const f = await ready(emptyWorkingListing(), (result) => {
      if (result.state === "succeeded" && result.stage === stage) {
        const copy = { ...result } as Record<string, unknown>;
        delete copy[
          stage === "verification" ? "frozenVerification" : "frozenQuality"
        ];
        return copy as WineStageResult;
      }
      return result;
    });
    await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
      stage === "verification"
        ? "projection_verification_required"
        : "projection_generation_required",
    );
    expect(
      await f.store.claim({ ...f.job, stage: "commit_candidate" }),
    ).toMatchObject({ status: "blocked", code: "stage_outcome_unknown" });
  },
);
it("projection retains mandatory needs_info quality outcome", async () => {
  const f = await ready(emptyWorkingListing(), (result) =>
    result.stage === "quality_check" && result.state === "succeeded"
      ? { ...result, outcome: "needs_info" }
      : result,
  );
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "completed",
    outcome: "needs_info",
  });
  expect(
    await db.forWorkspace(f.job.workspaceId, (r) =>
      r.listings.getById(f.run.listingId),
    ),
  ).toMatchObject({ status: "needs_info" });
});
it("projection preserves all merchant commercial values", async () => {
  const working = {
    ...emptyWorkingListing(),
    sku: "MERCHANT-SKU",
    priceHkd: 99,
    stockQuantity: 7,
  };
  const f = await ready(working);
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "completed",
  });
  const review = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.listings.getReviewSnapshot(f.run.listingId),
  );
  expect(review?.activeVersion?.content).toMatchObject({
    sku: "MERCHANT-SKU",
    priceHkd: 99,
    stockQuantity: 7,
  });
});
it("projection refuses stale ownership digest even when quality reports ready", async () => {
  const f = await ready(emptyWorkingListing(), (result) => {
    if (
      result.stage === "generation" &&
      result.state === "succeeded" &&
      result.frozenQuality
    )
      result.frozenQuality.request.ownership!.provenanceDigest = "0".repeat(64);
    return result;
  });
  await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
    "projection_ownership_changed",
  );
});
it("projection refuses a changed complete source pool", async () => {
  const f = await ready();
  await db.forWorkspace(f.job.workspaceId, (r) =>
    r.wineEnrichment.saveEvidence(f.run.id, [
      { ...f.source, id: randomUUID() },
    ]),
  );
  await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
    "projection_evidence_changed",
  );
});

it.each([
  "title.en",
  "title.zh-Hant",
  "seo.title.en",
  "seo.description.zh-Hant",
  "tags",
])("projection retains protected metadata %s", async (path) => {
  const working = emptyWorkingListing();
  const parts = path.split(".");
  let target: any = working;
  for (const part of parts.slice(0, -1)) target = target[part];
  const value = path === "tags" ? ["Manual tag"] : "Manual value";
  target[parts.at(-1)!] = value;
  const f = await ready(working, (result) => {
    if (
      result.stage === "generation" &&
      result.state === "succeeded" &&
      result.frozenQuality
    ) {
      let target: any = result.content;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)!] = value;
      result.frozenQuality.candidate.annotations =
        result.frozenQuality.candidate.annotations.filter(
          (a) => a.path !== path,
        );
    }
    return result;
  });
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "completed",
  });
  const review = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.listings.getReviewSnapshot(f.run.listingId),
  );
  let actual: any = review!.activeVersion!.content;
  for (const part of parts) actual = actual[part];
  expect(actual).toEqual(value);
});
it.each(["operator", "locked"])(
  "projection preserves persisted %s sections and whole bilingual locks",
  async (protection) => {
    const section = {
      key: "introduction" as const,
      en: "Original paragraph",
      "zh-Hant": "Original bilingual paragraph",
      claimIds: [randomUUID()],
      owner:
        protection === "operator"
          ? ("operator" as const)
          : ("automatic" as const),
      locked: protection === "locked",
    };
    const base = {
      ...emptyWorkingListing(),
      packQuantity: 1,
      title: { en: "Original title", "zh-Hant": "Original bilingual title" },
      description: { en: section.en, "zh-Hant": section["zh-Hant"] },
      seo: {
        title: { en: "Original SEO", "zh-Hant": "Original bilingual SEO" },
        description: {
          en: "Original summary",
          "zh-Hant": "Original bilingual summary",
        },
      },
      wineOwnership: { schemaVersion: 1 as const, sections: [section] },
    };
    const f = await ready(
      emptyWorkingListing(),
      (result) => {
        if (
          result.stage === "generation" &&
          result.state === "succeeded" &&
          result.frozenQuality
        ) {
          Object.assign(result.content, result.frozenQuality.request.current);
          result.frozenQuality.candidate.annotations = [];
        }
        return result;
      },
      base,
    );
    expect(await f.store.commitCandidate(f.context)).toMatchObject({
      status: "completed",
    });
    const review = await db.forWorkspace(f.job.workspaceId, (r) =>
      r.listings.getReviewSnapshot(f.run.listingId),
    );
    expect(review!.activeVersion!.content.description).toEqual(
      base.description,
    );
    expect(review!.activeVersion!.content.wineOwnership).toEqual(
      base.wineOwnership,
    );
    expect(review!.activeVersion!.content.title).toEqual(base.title);
    const adopted = await db.forWorkspace(f.job.workspaceId, (r) =>
      adoptedDb.readAdoptedWineDependencies(r, {
        workspaceId: f.job.workspaceId,
        listingId: f.run.listingId,
        versionId: review!.activeVersion!.id,
        inputRevision: f.run.inputRevision,
      }),
    );
    expect(adopted.status).toBe("available");
    if (adopted.status !== "available") throw Error(adopted.code);
    expect(adopted.adopted.sections).toEqual([section]);
    expect(adopted.unavailableSections).toContainEqual(
      expect.objectContaining({
        path: "sections.introduction.en",
        claimIds: section.claimIds,
      }),
    );
  },
);
it("projection rolls back if DB deadline elapses after the real version write", async () => {
  const f = await ready();
  let wrote = false;
  const scoped = {
    forWorkspace: async <T>(
      workspaceId: string,
      work: (r: import("@wukong/db").WorkspaceRepositories) => Promise<T>,
    ) =>
      db.forWorkspace(workspaceId, (r) =>
        work({
          ...r,
          pipelineRuns: {
            ...r.pipelineRuns,
            acceptanceTimestamp: async () =>
              wrote
                ? (f.run.execution.wineAcquisition as { deadlineAt: string })
                    .deadlineAt
                : r.pipelineRuns.acceptanceTimestamp(),
          },
          wineEnrichment: {
            ...r.wineEnrichment,
            saveSections: async (input) => {
              await r.wineEnrichment.saveSections(input);
              wrote = true;
            },
          },
        }),
      ),
  };
  await expect(
    createWineStageStore(scoped, {
      projectCandidate: projectWineCandidate,
    }).commitCandidate(f.context),
  ).rejects.toThrow("projection_deadline");
  expect(
    (
      await admin`select count(*)::int n from listing_versions where workspace_id=${f.job.workspaceId}`
    )[0].n,
  ).toBe(0);
});

it("projection rejects frozen verification locks that differ from accepted input", async () => {
  const f = await ready(emptyWorkingListing(), (result) => {
    if (
      result.state === "succeeded" &&
      result.stage === "verification" &&
      result.frozenVerification
    )
      result.frozenVerification.lockedFields = [];
    return result;
  });
  await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
    "projection_verification_locks_mismatch",
  );
});

function reviewBase() {
  const section = {
    key: "introduction" as const,
    en: "Original paragraph",
    "zh-Hant": "Original bilingual paragraph",
    claimIds: [],
    owner: "operator" as const,
    locked: false,
  };
  return {
    ...emptyWorkingListing(),
    packQuantity: 1,
    title: { en: "Original title", "zh-Hant": "Original bilingual title" },
    description: { en: section.en, "zh-Hant": section["zh-Hant"] },
    seo: {
      title: { en: "Original SEO", "zh-Hant": "Original bilingual SEO" },
      description: {
        en: "Original summary",
        "zh-Hant": "Original bilingual summary",
      },
    },
    wineOwnership: { schemaVersion: 1 as const, sections: [section] },
  };
}
function retainBase(result: WineStageResult): WineStageResult {
  if (
    result.stage === "generation" &&
    result.state === "succeeded" &&
    result.frozenQuality
  ) {
    Object.assign(result.content, result.frozenQuality.request.current);
    result.frozenQuality.candidate.annotations = [];
  }
  return result;
}
it.each(["in_review", "reopened"])(
  "projection retains %s active base when mandatory quality needs information",
  async (status) => {
    const f = await ready(
      emptyWorkingListing(),
      (r) =>
        r.stage === "quality_check" && r.state === "succeeded"
          ? { ...r, outcome: "needs_info" }
          : retainBase(r),
      reviewBase(),
    );
    if (status === "reopened")
      await admin`update listing_drafts set status='reopened' where workspace_id=${f.job.workspaceId} and id=${f.run.listingId}`;
    expect(await f.store.commitCandidate(f.context)).toMatchObject({
      status: "completed",
      outcome: "needs_info",
      versionId: null,
    });
    expect(
      await db.forWorkspace(f.job.workspaceId, (r) =>
        r.listings.getById(f.run.listingId),
      ),
    ).toMatchObject({ status, activeVersionId: f.run.baseVersionId });
    expect(
      (
        await admin`select count(*)::int n from listing_versions where workspace_id=${f.job.workspaceId}`
      )[0].n,
    ).toBe(1);
  },
);
it("projection moves a ready reopened base to review with a new version", async () => {
  const f = await ready(emptyWorkingListing(), retainBase, reviewBase());
  await admin`update listing_drafts set status='reopened' where workspace_id=${f.job.workspaceId} and id=${f.run.listingId}`;
  const done = await f.store.commitCandidate(f.context);
  expect(done).toMatchObject({ status: "completed", outcome: "complete" });
  expect(
    await db.forWorkspace(f.job.workspaceId, (r) =>
      r.listings.getById(f.run.listingId),
    ),
  ).toMatchObject({ status: "in_review" });
  if (done.status === "completed")
    expect(done.versionId).not.toBe(f.run.baseVersionId);
});
it("projection rejects expired web evidence instead of refreshing its capture age", async () => {
  const f = await ready(emptyWorkingListing(), (r) => r, undefined, 8);
  await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
    "projection_evidence_expired",
  );
});
it("projection rejects a newly changed reviewed registry before writing any version", async () => {
  const f = await ready(),
    reviewer = randomUUID();
  await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values(${f.job.workspaceId},${reviewer},'reviewer')`;
  await db.forWorkspace(f.job.workspaceId, (r) =>
    r.wineEnrichment.recordReviewedAuthority(reviewer, {
      schemaVersion: 1,
      domain: "wine.test",
      subject: { kind: "producer", name: "Fixture Estate" },
      proofUrl: "https://wine.test/about",
      proofDigest: "a".repeat(64),
      verifiedAt: f.run.acceptedAt,
      expiresAt: new Date(
        Date.parse(f.run.acceptedAt) + 86400000,
      ).toISOString(),
      revokedAt: null,
      verifierId: reviewer,
    }),
  );
  await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
    "projection_evidence_changed",
  );
  expect(
    (
      await admin`select count(*)::int n from listing_versions where workspace_id=${f.job.workspaceId}`
    )[0].n,
  ).toBe(0);
});
it("projection fences a newly saved revision before any candidate mutation", async () => {
  const f = await ready();
  await db.forWorkspace(f.job.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.run.listingId,
        actorId: "test",
        expectedInputRevision: 1,
        baseVersionId: null,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [],
        note: "New note",
      },
      {
        workspaceId: f.job.workspaceId,
        actorId: "test",
        entityId: f.run.listingId,
      },
      r.audit,
    ),
  );
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "stopped",
  });
  expect(
    (
      await admin`select count(*)::int n from listing_versions where workspace_id=${f.job.workspaceId}`
    )[0].n,
  ).toBe(0);
});
it("projection cannot replace operator title with an unprotected candidate even after ready quality", async () => {
  const f = await ready({
    ...emptyWorkingListing(),
    title: { en: "Operator title", "zh-Hant": "" },
  });
  await expect(f.store.commitCandidate(f.context)).rejects.toThrow(
    "projection_candidate_invalid",
  );
});

it("projection preserves an explicitly locked unknown pack quantity without substituting observed identity", async () => {
  const f = await ready(emptyWorkingListing(), (r) => r, undefined, 0, true);
  expect(await f.store.commitCandidate(f.context)).toMatchObject({
    status: "completed",
    outcome: "needs_info",
    versionId: null,
  });
  expect(
    (
      await admin`select count(*)::int n from listing_versions where workspace_id=${f.job.workspaceId}`
    )[0].n,
  ).toBe(0);
});
it("ownership outer reader sanitizes transaction-open errors after repository extraction", async () => {
  const f = await ready();
  const unavailable = {
    forWorkspace: async () => {
      throw Error("synthetic_open_failure");
    },
  } as Pick<import("@wukong/db").Database, "forWorkspace">;
  await expect(
    readWineGenerationOwnership(unavailable, f.context),
  ).resolves.toEqual({ status: "unavailable", code: "ownership_unavailable" });
});
import * as adoptedDb from "@wukong/db";
it("reads actual adopted support from its terminal origin, not the running-only ownership reader", async () => {
  const f = await ready();
  const committed = await f.store.commitCandidate(f.context);
  if (committed.status !== "completed" || !committed.versionId)
    throw Error("missing version");
  expect(adoptedDb).toHaveProperty("readAdoptedWineDependencies");
  const result = await db.forWorkspace(f.job.workspaceId, (r) =>
    adoptedDb.readAdoptedWineDependencies(r, {
      workspaceId: f.job.workspaceId,
      listingId: f.run.listingId,
      versionId: committed.versionId!,
      inputRevision: f.run.inputRevision,
    }),
  );
  expect(result).toMatchObject({
    status: "available",
    originRunId: f.run.id,
    versionId: committed.versionId!,
    origins: [
      expect.objectContaining({
        runId: f.run.id,
        inputDigest: f.run.execution.wineInputDigest,
        sourceDigest: f.run.execution.wineSourceDigest,
      }),
    ],
  });
  if (result.status !== "available") throw Error(result.code);
  expect(result.supports).toContainEqual(
    expect.objectContaining({
      path: "sections.introduction.en",
      claimId: f.claim.id,
      valid: true,
      originVersionId: committed.versionId,
    }),
  );
});
async function adoptedFixture(
  working = emptyWorkingListing(),
  sourceAgeDays = 0,
  reliable = false,
) {
  const f = await ready(
    working,
    (r) => r,
    undefined,
    sourceAgeDays,
    false,
    undefined,
    reliable,
  );
  const done = await f.store.commitCandidate(f.context);
  if (done.status !== "completed" || !done.versionId)
    throw Error("version missing");
  const coordinates = {
    workspaceId: f.job.workspaceId,
    listingId: f.run.listingId,
    versionId: done.versionId,
    inputRevision: f.run.inputRevision,
  };
  const read = (
    overrides?: (
      r: import("@wukong/db").WorkspaceRepositories,
    ) => import("@wukong/db").WorkspaceRepositories,
  ) =>
    db.forWorkspace(coordinates.workspaceId, (r) =>
      adoptedDb.readAdoptedWineDependencies(
        overrides ? overrides(r) : r,
        coordinates,
      ),
    );
  const save = async (
    patch: Partial<import("@wukong/db").SaveListingInput>,
  ) => {
    const input = await db.forWorkspace(coordinates.workspaceId, (r) =>
      r.listingInputs.save(
        {
          listingId: coordinates.listingId,
          actorId: "test",
          expectedInputRevision: coordinates.inputRevision,
          baseVersionId: coordinates.versionId,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          changes: [],
          ...patch,
        },
        {
          workspaceId: coordinates.workspaceId,
          actorId: "test",
          entityId: coordinates.listingId,
        },
        r.audit,
      ),
    );
    coordinates.inputRevision = input.revision;
  };
  return { ...f, coordinates, read, save };
}
it("adopted merchant-note changes invalidate their dependent copy", async () => {
  const f = await adoptedFixture();
  await f.save({ note: "Changed merchant note" });
  const result = await f.read();
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error(result.code);
  expect(
    result.supports.every(
      (s) => !s.valid && s.invalidReason === "source_changed",
    ),
  ).toBe(true);
});
it("adopted identity edits invalidate product evidence across sections", async () => {
  const f = await adoptedFixture();
  await f.save({
    changes: [{ field: "volumeMl", value: 1500, state: "manual" }],
  });
  const result = await f.read();
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error(result.code);
  expect(
    result.supports.every(
      (s) => !s.valid && s.invalidReason === "identity_changed",
    ),
  ).toBe(true);
});
it("adopted commercial edits retain support and operator price ownership", async () => {
  const f = await adoptedFixture();
  await f.save({
    changes: [{ field: "priceHkd", value: 400, state: "manual" }],
  });
  const result = await f.read();
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error(result.code);
  expect(result.supports.every((s) => s.valid)).toBe(true);
});
it("legacy adopted descriptions exclude all proposed generation paragraphs", async () => {
  const f = await adoptedFixture({
    ...emptyWorkingListing(),
    description: { en: "Manual description", "zh-Hant": "Manual description" },
  });
  const result = await f.read();
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error(result.code);
  expect(result.adopted.sections).toEqual([]);
  expect(result.supports.some((s) => s.path.startsWith("sections."))).toBe(
    false,
  );
});

it("adopted inherited sections retain their original version, claims and capture age across later runs", async () => {
  const first = await adoptedFixture();

  const next = await ready(
    emptyWorkingListing(),
    (r) => r,
    undefined,
    0,
    false,
    {
      workspaceId: first.coordinates.workspaceId,
      listingId: first.coordinates.listingId,
    },
  );
  const done = await next.store.commitCandidate(next.context);
  if (done.status !== "completed" || !done.versionId)
    throw Error("no second version");
  const result = await db.forWorkspace(first.coordinates.workspaceId, (r) =>
    adoptedDb.readAdoptedWineDependencies(r, {
      ...first.coordinates,
      versionId: done.versionId!,
    }),
  );
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error(result.code);
  expect(result.supports).toContainEqual(
    expect.objectContaining({
      path: "sections.introduction.en",
      claimId: first.claim.id,
      originVersionId: first.coordinates.versionId,
      valid: true,
    }),
  );
  expect(
    result.supports.find((s) => s.claimId === first.claim.id)?.sources[0]
      ?.capturedAt,
  ).toBe(first.source.capturedAt);
});
it("adopted web claims survive unrelated merchant note edits but expire at their original seven-day boundary", async () => {
  const f = await adoptedFixture(emptyWorkingListing(), 1);
  await f.save({ note: "A changed note that did not support the web claim" });
  const valid = await f.read();
  expect(valid.status).toBe("available");
  if (valid.status !== "available") throw Error(valid.code);
  expect(valid.supports.every((s) => s.valid)).toBe(true);
  const expired = await f.read((r) => ({
    ...r,
    pipelineRuns: {
      ...r.pipelineRuns,
      acceptanceTimestamp: async () =>
        new Date(Date.parse(f.source.capturedAt) + 7 * 86400000).toISOString(),
    },
  }));
  expect(expired).toEqual({
    status: "unavailable",
    code: "evidence_refresh_required",
  });
});
it("adopted evidence rejects a future capture without hidden refresh", async () => {
  const f = await adoptedFixture();
  const result = await f.read((r) => ({
    ...r,
    pipelineRuns: {
      ...r.pipelineRuns,
      acceptanceTimestamp: async () =>
        new Date(Date.parse(f.run.acceptedAt) - 1).toISOString(),
    },
  }));
  expect(result.status).toBe("unavailable");
});
for (const kind of [
  "foreign",
  "version",
  "revision",
  "missing-origin",
  "forged-ownership",
  "source-pool",
  "registry",
] as const)
  it(`adopted rejects ${kind} binding`, async () => {
    const f = await adoptedFixture();
    if (kind === "foreign") f.coordinates.workspaceId = "other-workspace";
    if (kind === "version") f.coordinates.versionId = randomUUID();
    if (kind === "revision") f.coordinates.inputRevision++;
    const result = await f.read((r) => ({
      ...r,
      wineEnrichment: {
        ...r.wineEnrichment,
        ...(kind === "missing-origin"
          ? { readVersionOrigin: async () => null }
          : {}),
        ...(kind === "forged-ownership"
          ? {
              readVersionOrigin: async (
                listingId: string,
                versionId: string,
              ) => {
                const v = await r.wineEnrichment.readVersionOrigin(
                  listingId,
                  versionId,
                );
                return v
                  ? { ...v, sections: { ...v.sections!, sections: [] } }
                  : null;
              },
            }
          : {}),
        ...(kind === "source-pool" ? { readEvidence: async () => [] } : {}),
        ...(kind === "registry"
          ? {
              readAuthorities: async () =>
                [{ schemaVersion: 1, domain: "forged.test" }] as any,
            }
          : {}),
      },
    }));
    expect(result.status).toBe("unavailable");
  });
for (const kind of [
  "quality",
  "claims",
  "frozen",
  "ownership",
  "model",
  "blocking",
] as const)
  it(`adopted rejects rehashed ${kind} artifact tampering`, async () => {
    const f = await adoptedFixture();
    const result = await db.forWorkspace(
      f.coordinates.workspaceId,
      async (r) => {
        const run = structuredClone(
          (await r.pipelineRuns.getOperation(f.run.id))!,
        );
        if (kind === "model")
          (run.execution.wineGo as any).model = "unreviewed";
        const rows = [] as import("@wukong/db").StageRecord[];
        for (const stage of adoptedDb.WINE_STAGE_ORDER) {
          const row = structuredClone(
            (await r.wineEnrichment.readStage(run.id, stage))!,
          );
          const artifact = (row.output as any)?.result;
          if (stage === "quality_check" && kind === "quality")
            artifact.contentDigest = "a".repeat(64);
          if (stage === "quality_check" && kind === "blocking")
            artifact.issues = [
              {
                path: "title.en",
                code: "unsupported",
                blocking: true,
                evidenceIds: [],
              },
            ];
          if (stage === "verification" && kind === "claims")
            artifact.claims[0].value = "A different producer";
          if (stage === "verification" && kind === "frozen")
            delete artifact.frozenVerification;
          if (stage === "generation" && kind === "ownership")
            artifact.frozenQuality.request.ownership.provenanceDigest =
              "a".repeat(64);
          row.dependencyDigest = adoptedDb.wineStageDependencyDigest(run, rows);
          rows.push(row);
        }
        return adoptedDb.readAdoptedWineDependencies(
          {
            ...r,
            pipelineRuns: { ...r.pipelineRuns, getOperation: async () => run },
            wineEnrichment: {
              ...r.wineEnrichment,
              readStage: async (_id, stage) =>
                rows.find((x) => x.stage === stage) ?? null,
            },
          },
          f.coordinates,
        );
      },
    );
    expect(result.status).toBe("unavailable");
  });
it("adopted reports unavailable inherited support while retaining protected text", async () => {
  const first = await adoptedFixture();
  const next = await ready(
    emptyWorkingListing(),
    (r) => r,
    undefined,
    0,
    false,
    {
      workspaceId: first.coordinates.workspaceId,
      listingId: first.coordinates.listingId,
    },
  );
  const done = await next.store.commitCandidate(next.context);
  if (done.status !== "completed" || !done.versionId) throw Error("no version");
  const result = await db.forWorkspace(first.coordinates.workspaceId, (r) =>
    adoptedDb.readAdoptedWineDependencies(
      {
        ...r,
        wineEnrichment: {
          ...r.wineEnrichment,
          readStage: async (id, stage) =>
            id === first.run.id ? null : r.wineEnrichment.readStage(id, stage),
        },
      },
      { ...first.coordinates, versionId: done.versionId! },
    ),
  );
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error(result.code);
  expect(result.adopted.sections[0]?.claimIds).toEqual([first.claim.id]);
  expect(result.unavailableSections).toContainEqual(
    expect.objectContaining({
      path: "sections.introduction.en",
      claimIds: [first.claim.id],
    }),
  );
  expect(result.refreshRequired).toBe(true);
});
it("adopted registry read holds workspace serialization until the admission transaction commits", async () => {
  const f = await adoptedFixture();
  const reviewer = randomUUID();
  await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values(${f.coordinates.workspaceId},${reviewer},'reviewer')`;
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    readyRead = new Promise<void>((resolve) => (entered = resolve));
  const reader = db.forWorkspace(f.coordinates.workspaceId, async (r) => {
    const result = await adoptedDb.readAdoptedWineDependencies(
      r,
      f.coordinates,
    );
    expect(result.status).toBe("available");
    entered();
    await held;
    return result;
  });
  await readyRead;
  let written = false;
  const writer = db.forWorkspace(f.coordinates.workspaceId, async (r) => {
    await r.wineEnrichment.recordReviewedAuthority(reviewer, {
      schemaVersion: 1,
      domain: "wine.test",
      subject: { kind: "producer", name: "Fixture Estate" },
      proofUrl: "https://wine.test/about",
      proofDigest: "a".repeat(64),
      verifiedAt: f.run.acceptedAt,
      expiresAt: new Date(
        Date.parse(f.run.acceptedAt) + 86400000,
      ).toISOString(),
      revokedAt: f.run.acceptedAt,
      verifierId: reviewer,
    });
    written = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(written).toBe(false);
  } finally {
    release();
  }
  await reader;
  await writer;
  expect(await f.read()).toEqual({
    status: "unavailable",
    code: "adopted_authority_changed",
  });
});
it("adopted rejects a version whose original pipeline idempotency key differs", async () => {
  const f = await adoptedFixture();
  const result = await f.read((r) => ({
    ...r,
    wineEnrichment: {
      ...r.wineEnrichment,
      readVersionOrigin: async (listingId, versionId) => {
        const row = await r.wineEnrichment.readVersionOrigin(
          listingId,
          versionId,
        );
        return row ? { ...row, pipelineIdempotencyKey: "forged" } : null;
      },
    },
  }));
  expect(result.status).toBe("unavailable");
});
it("adopted re-evaluates reliable-source review expiry with unchanged registry rows", async () => {
  const f = await adoptedFixture(emptyWorkingListing(), 1, true);
  expect((await f.read()).status).toBe("available");
  const result = await f.read((r) => ({
    ...r,
    pipelineRuns: {
      ...r.pipelineRuns,
      acceptanceTimestamp: async () =>
        new Date(Date.parse(f.run.acceptedAt) + 2 * 3600000).toISOString(),
    },
  }));
  expect(result.status).toBe("unavailable");
});
for (const tampering of [
  "omitted_supports",
  "forged_trust",
  "forged_identity",
  "forged_aliases",
] as const)
  it(`adopted independently rejects ${tampering} with recomputed stage hashes`, async () => {
    const f = await adoptedFixture();
    const result = await db.forWorkspace(
      f.coordinates.workspaceId,
      async (r) => {
        const run = (await r.pipelineRuns.getOperation(f.run.id))!,
          rows = [] as import("@wukong/db").StageRecord[];
        for (const stage of adoptedDb.WINE_STAGE_ORDER) {
          const row = structuredClone(
            (await r.wineEnrichment.readStage(run.id, stage))!,
          );
          const artifact = (row.output as any)?.result;
          if (stage === "verification") {
            const frozen = artifact.frozenVerification;
            if (tampering === "omitted_supports")
              frozen.supports = frozen.supports.filter(
                (s: any) => s.field === "producer",
              );
            if (tampering === "forged_trust")
              frozen.sources[0].trust = "reliable";
            if (tampering === "forged_identity")
              frozen.sources[0].identity.status = "matched";
            if (tampering === "forged_aliases")
              frozen.verifiedAliases = [
                {
                  producer: "Fixture Estate",
                  canonicalName: "Reserve Red",
                  alias: "forged alias",
                },
              ];
          }
          row.dependencyDigest = adoptedDb.wineStageDependencyDigest(run, rows);
          rows.push(row);
        }
        return adoptedDb.readAdoptedWineDependencies(
          {
            ...r,
            wineEnrichment: {
              ...r.wineEnrichment,
              readStage: async (_id, stage) =>
                rows.find((x) => x.stage === stage) ?? null,
            },
          },
          f.coordinates,
        );
      },
    );
    expect(result.status).toBe("unavailable");
  });
it("adopted rejects omitted contrary-field supports while retaining the complete contrary source pool", async () => {
  const f = await adoptedFixture();
  const result = await db.forWorkspace(f.coordinates.workspaceId, async (r) => {
    const run = (await r.pipelineRuns.getOperation(f.run.id))!,
      input = (await r.listingInputs.getRevision(
        run.listingId,
        run.inputRevision,
      ))!;
    const originalSources = await r.wineEnrichment.readEvidence(run.id);
    const contrary = webEvidence({
      id: randomUUID(),
      excerpt:
        "Kind: wine\nProducer: Fixture Estate\nProduct: Reserve Red\nVolume: 1500 ml\nPack quantity: 1 bottles\nMarket: HK",
      capturedAt: f.run.acceptedAt,
    });
    const sources = [...originalSources, contrary];
    const rows = [] as import("@wukong/db").StageRecord[];
    for (const stage of adoptedDb.WINE_STAGE_ORDER) {
      const row = structuredClone(
        (await r.wineEnrichment.readStage(run.id, stage))!,
      );
      const artifact = (row.output as any)?.result;
      if (stage === "verification") {
        const frozen = artifact.frozenVerification,
          binding = frozen.binding;
        const derived = groundWineEvidence({
          accepted: {
            binding,
            assets: [],
            note: input.note,
            lockedFields: frozen.lockedFields,
            verifiedAliases: [],
          },
          extraction: { binding, identity: frozen.identity },
          records: sources.map((source) => ({
            binding,
            assetDigest: null,
            documentDigest: source.documentDigest,
            source,
          })),
          authorities: frozen.authorities,
          now: frozen.now,
        }).context;
        expect(
          derived.supports.some(
            (s) =>
              s.sourceId === contrary.id &&
              s.field === "volumeMl" &&
              s.value === 1500,
          ),
        ).toBe(true);
        artifact.frozenVerification = {
          ...derived,
          acceptedPremises: frozen.acceptedPremises,
          supports: derived.supports.filter((s) => s.sourceId !== contrary.id),
        };
      }
      row.dependencyDigest = adoptedDb.wineStageDependencyDigest(run, rows);
      rows.push(row);
    }
    return adoptedDb.readAdoptedWineDependencies(
      {
        ...r,
        wineEnrichment: {
          ...r.wineEnrichment,
          readEvidence: async () => sources,
          readStage: async (_id, stage) =>
            rows.find((s) => s.stage === stage) ?? null,
        },
      },
      f.coordinates,
    );
  });
  expect(result).toEqual({
    status: "unavailable",
    code: "adopted_grounding_invalid",
  });
});

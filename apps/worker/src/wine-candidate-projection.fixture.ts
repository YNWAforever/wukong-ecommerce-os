import * as adoptedDb from "@wukong/db";
import { groundWineEvidence, decideWineClaim } from "@wukong/core";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect } from "vitest";
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
export const db = createDatabase(url);
export const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
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
  existing?: {
    workspaceId: string;
    listingId: string;
    mode?: "full" | "research";
  },
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
        wineMode: existing?.mode ?? "full",
        profile: { tone: "Clear", claimPolicy: [] },
        wineBudget: createWineBudgetSnapshot(existing?.mode ?? "full"),
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

export async function ready(
  working = emptyWorkingListing(),
  mutate: (result: WineStageResult) => WineStageResult = (r) => r,
  base?: import("@wukong/core").ReviewableListing,
  sourceAgeDays = 0,
  lockedUnknownPack = false,
  existing?: {
    workspaceId: string;
    listingId: string;
    mode?: "full" | "research";
  },
  reliable = false,
  reviewDuration = 3600000,
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
            Date.parse(f.run.acceptedAt) +
              (reliable ? reviewDuration : 30 * 86400000),
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
  ] as const) {
    const delivery = await runWineStage(
      { ...f.job, stage },
      { store, execute: async (c) => mutate(await execute(c)) },
    );
    if (delivery.status === "blocked") {
      expect(delivery.code).toBe("generation_authorization_changed");
      expect(
        await db.forWorkspace(f.job.workspaceId, (r) =>
          r.wineEnrichment.readStage(f.run.id, "commit_candidate"),
        ),
      ).toBeNull();
      expect(
        (
          await admin`select count(*)::int n from listing_versions where workspace_id=${f.job.workspaceId}`
        )[0].n,
      ).toBe(base ? 1 : 0);
      throw Error(delivery.code);
    }
    expect(delivery).toMatchObject({ status: "advanced" });
  }
  const claimed = await store.claim({ ...f.job, stage: "commit_candidate" });
  if (claimed.status !== "claimed") throw Error(JSON.stringify(claimed));
  return { ...f, store, context: claimed.context, content, claim, source };
}

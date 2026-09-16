import { createHash } from "node:crypto";
import {
  listingInputDigest,
  type Database,
  type ListingOperation,
  type StageRecord,
  type WorkspaceRepositories,
} from "@wukong/db";
import type { EvidenceSource } from "@wukong/core";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import {
  parseWineStageResult,
  type WineStageContext,
  WINE_STAGE_ORDER,
} from "./wine-enrichment-pipeline.js";
import { readWineExtractionContext } from "./wine-extraction-handler.js";
import {
  wineCompleteEvidenceCacheKey,
  wineEvidenceCacheKey,
  wineIdentityQueries,
  type EvidenceRequest,
} from "./wine-evidence-acquisition.js";
export type WineCacheOrigin = {
  schemaVersion: 1;
  runId: string;
  snapshotId: string;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function uuid(value: string) {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function requireProof(value: unknown): asserts value {
  if (!value) throw Error("cache_incomplete");
}
function digest(run: ListingOperation, dependencies: StageRecord[]) {
  return listingInputDigest({
    runId: run.id,
    inputDigest: run.execution.wineInputDigest,
    sourceDigest: run.execution.wineSourceDigest,
    mode: run.execution.wineMode,
    budget: run.execution.wineBudget,
    go: run.execution.wineGo,
    policy: run.execution.wineEnrichment,
    dependencies,
  });
}
function same(a: unknown, b: unknown) {
  return listingInputDigest(a) === listingInputDigest(b);
}
function pool(sources: EvidenceSource[]) {
  return [...sources].sort((a, b) => a.id.localeCompare(b.id));
}
function result(record: StageRecord) {
  const wrapper = record.output as {
    schemaVersion?: number;
    fresh?: boolean;
    result?: unknown;
  };
  requireProof(
    record.state === "succeeded" &&
      wrapper?.schemaVersion === 1 &&
      wrapper.fresh === true,
  );
  const parsed = parseWineStageResult(wrapper.result, record.stage);
  requireProof(parsed.state === "succeeded");
  return parsed;
}
function request(
  workspaceId: string,
  run: ListingOperation,
  identity: EvidenceRequest["identity"],
  now: string,
): EvidenceRequest {
  const p = wineAcquisitionPolicySchema.parse(run.execution.wineAcquisition);
  return {
    workspaceId,
    runId: run.id,
    inputRevision: run.inputRevision,
    identity,
    now,
    forceRefresh: run.execution.wineMode === "research",
    policyDigest: p.policyVersion,
    rulesVersion: p.rulesVersion,
    allowedDomains: p.allowedDomains,
  };
}
function key(input: EvidenceRequest, run: ListingOperation) {
  return {
    identityKey: hash(
      wineCompleteEvidenceCacheKey(input) +
        listingInputDigest(run.execution.wineEnrichment),
    ),
    policyVersion: input.policyDigest,
    rulesVersion: input.rulesVersion,
  };
}
function context(
  workspaceId: string,
  run: ListingOperation,
  dependencies: StageRecord[],
): WineStageContext {
  return {
    schemaVersion: 1,
    job: {
      schemaVersion: 2,
      flowVersion: "wine-enrichment-v1",
      workspaceId,
      runId: run.id,
      draftId: run.listingId,
      inputRevision: run.inputRevision,
      activeVersionSequence: run.activeVersionSequence,
      stage: "generation",
    },
    run,
    dependencyDigest: digest(run, dependencies),
    dependencies,
  };
}
/** Pure DB inspection only. Origin must be direct fresh research, never a cache chain. */
async function inspect(
  r: WorkspaceRepositories,
  workspaceId: string,
  runId: string,
) {
  const run = await r.pipelineRuns.getOperation(runId);
  requireProof(
    run &&
      run.execution.flowVersion === "wine-enrichment-v1" &&
      ["full", "research"].includes(String(run.execution.wineMode)),
  );
  const stages: StageRecord[] = [];
  for (const stage of WINE_STAGE_ORDER.slice(0, 5)) {
    const record = await r.wineEnrichment.readStage(runId, stage);
    requireProof(
      record &&
        record.runId === runId &&
        record.inputDigest === run.execution.wineInputDigest &&
        record.dependencyDigest === digest(run, stages),
    );
    if (record.state === "skipped") {
      const verification = result(stages[2]!);
      requireProof(
        ["search_deep", "verification_deep"].includes(stage) &&
          verification.stage === "verification" &&
          !verification.needsDeepSearch &&
          same(record.output, {
            schemaVersion: 1,
            reason: "deep_search_not_required",
          }),
      );
    } else result(record);
    stages.push(record);
  }
  const basic = result(stages[1]!);
  const verified = result(stages[2]!);
  requireProof(
    basic.stage === "search_basic" &&
      !basic.partial &&
      !("cacheOrigin" in basic) &&
      verified.stage === "verification",
  );
  let latest = basic;
  if (verified.needsDeepSearch) {
    const deep = result(stages[3]!);
    const final = result(stages[4]!);
    const decision = (stages[2]!.output as Record<string, unknown>)
      .deepSearchDecision;
    requireProof(
      same(decision, {
        schemaVersion: 1,
        required: true,
        reasons: verified.deepSearchReasons,
      }) &&
        deep.stage === "search_deep" &&
        !deep.partial &&
        !("cacheOrigin" in deep) &&
        final.stage === "verification_deep" &&
        !final.needsDeepSearch,
    );
    latest = deep;
  }
  const sources = await r.wineEnrichment.readEvidence(runId);
  requireProof(same(pool(latest.evidence), pool(sources)));
  requireProof(
    basic.evidence.every((s) => sources.some((row) => same(row, s))),
  );
  const calls = [];
  for (const slot of [
    "basic_1",
    "basic_2",
    "advanced_1",
    "extract_1",
  ] as const) {
    const call = await r.wineEnrichment.readSearchCall(runId, slot);
    if (
      slot === "basic_1" ||
      (slot === "advanced_1" && verified.needsDeepSearch)
    )
      requireProof(call);
    if (call) {
      requireProof(
        call.runId === runId &&
          call.status === "succeeded" &&
          call.output &&
          call.credits !== null &&
          call.credits <= call.maximumCredits &&
          call.maximumCredits === (slot === "advanced_1" ? 2 : 1),
      );
      requireProof(slot !== "advanced_1" || verified.needsDeepSearch);
      calls.push(call);
    }
  }
  return {
    run,
    stages,
    sources,
    calls,
    context: context(workspaceId, run, stages),
  };
}
export function createWineCompleteEvidenceCache(config: {
  database: Pick<Database, "forWorkspace">;
}) {
  const db = config.database;
  async function prove(workspaceId: string, runId: string) {
    const origin = await db.forWorkspace(workspaceId, (r) =>
      inspect(r, workspaceId, runId),
    );
    const extraction = await readWineExtractionContext(db, origin.context);
    const input = request(
      workspaceId,
      origin.run,
      extraction.context.identity,
      extraction.context.now,
    );
    const legacyKey = {
      identityKey: hash(wineEvidenceCacheKey(input)),
      policyVersion: input.policyDigest,
      rulesVersion: input.rulesVersion,
    };
    const queries = wineIdentityQueries(input.identity);
    for (const call of origin.calls)
      if (call.slot !== "extract_1") {
        const depth = call.slot === "advanced_1" ? "advanced" : "basic";
        requireProof(
          call.requestDigest ===
            hash(
              JSON.stringify({
                key: legacyKey,
                query: queries[call.slot === "basic_2" ? 1 : 0],
                depth,
              }),
            ),
        );
      }
    const web = pool(origin.sources.filter((s) => s.kind === "web"));
    requireProof(web.length > 0);
    for (const source of web) {
      requireProof(
        source.url &&
          input.allowedDomains.includes(new URL(source.url).hostname) &&
          new URL(source.url).protocol === "https:" &&
          !new URL(source.url).username &&
          !new URL(source.url).password &&
          !new URL(source.url).port,
      );
      const snippet = origin.calls.some(
        (call) =>
          call.slot !== "extract_1" &&
          call.output!.results.some((v) => {
            const u = new URL(v.url);
            u.hash = "";
            return (
              source.id ===
                uuid(runId + call.requestDigest + u.href + "snippet") &&
              source.url === u.href &&
              source.location === `tavily:${call.slot}` &&
              source.contentScope === "snippet" &&
              source.excerpt === v.content &&
              source.capturedAt === call.updatedAt &&
              source.documentDigest === "sha256:" + hash(v.content)
            );
          }),
      );
      const document =
        source.contentScope === "document" &&
        web.some(
          (s) =>
            s.contentScope === "snippet" &&
            source.id === uuid(s.id + "document"),
        );
      const extracted =
        source.contentScope === "document" &&
        origin.calls.some(
          (call) =>
            call.slot === "extract_1" &&
            call.output!.results.some(
              (v) =>
                source.id ===
                  uuid(runId + call.requestDigest + v.url + "extract") &&
                source.url === v.url &&
                source.excerpt === v.content &&
                source.capturedAt === call.updatedAt &&
                source.documentDigest === "sha256:" + hash(v.content) &&
                source.location.startsWith("tavily:extract_1;source:") &&
                web.some(
                  (s) =>
                    source.location === `tavily:extract_1;source:${s.id}` &&
                    s.contentScope === "snippet",
                ),
            ),
        );
      requireProof(snippet || document || extracted);
    }
    return { ...origin, input, key: key(input, origin.run), web };
  }
  return {
    async publish(input: {
      workspaceId: string;
      runId: string;
    }): Promise<
      | { status: "published"; cacheOrigin: WineCacheOrigin }
      | { status: "skipped"; code: string }
    > {
      try {
        const origin = await prove(input.workspaceId, input.runId);
        if (
          origin.web.length > 20 ||
          new TextEncoder().encode(
            JSON.stringify({ schemaVersion: 1, sources: origin.web }),
          ).length > 200000
        )
          return { status: "skipped", code: "cache_pool_oversized" };
        const snapshotId = uuid(
          "wine-complete-evidence@1:" +
            input.runId +
            listingInputDigest(origin.web),
        );
        await db.forWorkspace(input.workspaceId, async (r) => {
          const current = await inspect(r, input.workspaceId, input.runId);
          requireProof(
            same(current.stages, origin.stages) &&
              same(current.sources, origin.sources) &&
              same(current.calls, origin.calls) &&
              same(current.run.execution, origin.run.execution),
          );
          await r.wineAcquisition.saveCacheSnapshot({
            ...origin.key,
            runId: input.runId,
            snapshotId,
            sourceIds: origin.web.map((s) => s.id),
          });
        });
        return {
          status: "published",
          cacheOrigin: { schemaVersion: 1, runId: input.runId, snapshotId },
        };
      } catch {
        return { status: "skipped", code: "cache_incomplete" };
      }
    },
    async reuse(c: WineStageContext): Promise<
      | { status: "miss" }
      | {
          status: "hit";
          sources: EvidenceSource[];
          cacheOrigin: WineCacheOrigin;
        }
    > {
      try {
        requireProof(
          c.job.stage === "search_basic" && c.run.execution.wineMode === "full",
        );
        const extraction = await readWineExtractionContext(db, c);
        const input = request(
          c.job.workspaceId,
          c.run,
          extraction.context.identity,
          extraction.context.now,
        );
        const snapshot = await db.forWorkspace(c.job.workspaceId, (r) =>
          r.wineAcquisition.readCacheSnapshot(key(input, c.run)),
        );
        requireProof(snapshot && snapshot.runId !== c.run.id);
        const origin = await prove(c.job.workspaceId, snapshot.runId);
        requireProof(
          same(origin.key, key(input, c.run)) &&
            same(pool(snapshot.payload.sources), origin.web) &&
            snapshot.snapshotId ===
              uuid(
                "wine-complete-evidence@1:" +
                  origin.run.id +
                  listingInputDigest(origin.web),
              ),
        );
        await db.forWorkspace(c.job.workspaceId, async (r) => {
          const run = await r.pipelineRuns.getOperation(c.run.id);
          requireProof(run && same(run.execution, c.run.execution));
          requireProof(await r.wineAcquisition.authorizeAcquisition(input));
          const stage = await r.wineEnrichment.readStage(
            run.id,
            "search_basic",
          );
          const extractionStage = await r.wineEnrichment.readStage(
            run.id,
            "extraction",
          );
          requireProof(
            stage?.state === "started" &&
              extractionStage &&
              same(c.dependencies, [extractionStage]) &&
              stage.dependencyDigest === digest(run, [extractionStage]) &&
              stage.dependencyDigest === c.dependencyDigest,
          );
          for (const slot of [
            "basic_1",
            "basic_2",
            "advanced_1",
            "extract_1",
          ] as const)
            requireProof(
              !(await r.wineEnrichment.readSearchCall(run.id, slot)),
            );
          const current = await r.wineEnrichment.readEvidence(run.id);
          requireProof(current.every((s) => s.kind !== "web"));
          const fresh = await r.wineAcquisition.readCacheSnapshot(origin.key);
          requireProof(fresh && same(fresh, snapshot));
          const authorized =
            await r.wineAcquisition.authorizeAcquisition(input);
          requireProof(authorized);
          const now = Date.parse(authorized.now);
          requireProof(
            origin.web.every(
              (source) =>
                Date.parse(source.capturedAt) <= now &&
                Date.parse(source.capturedAt) > now - 7 * 86400000,
            ),
          );
          await r.wineEnrichment.saveEvidence(run.id, origin.web);
        });
        return {
          status: "hit",
          sources: structuredClone(origin.web),
          cacheOrigin: {
            schemaVersion: 1,
            runId: snapshot.runId,
            snapshotId: snapshot.snapshotId,
          },
        };
      } catch {
        return { status: "miss" };
      }
    },
  };
}

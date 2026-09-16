import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
import { createHash } from "node:crypto";
import {
  listingInputDigest,
  type Database,
  type SourceAsset,
  type WorkspaceRepositories,
} from "@wukong/db";
import type { ProductIdentity } from "@wukong/core";
import {
  wineOperationAI,
  type WineOperationTransport,
} from "./wine-operation-ai.js";
import { groundWineEvidence } from "./wine-evidence-grounding.js";
import {
  parseWineStageResult,
  type WineStageContext,
  type WineStageExecutor,
} from "./wine-enrichment-pipeline.js";

export const WINE_EXTRACTION_CONTEXT_KEY = "wine-extraction@1";
export type WineExtractionConfig = {
  database: Pick<Database, "forWorkspace">;
  env: { OPENCODE_GO_API_KEY?: string };
  /** Server storage adapter; receives only a tenant-checked accepted analyse image. No I/O inside DB callbacks. */
  resolveImage: (
    asset: SourceAsset,
  ) => Promise<{ bytes: Uint8Array; readUrl: string }>;
  transport?: WineOperationTransport;
};
class ExtractionFenceError extends Error {}
function requireValid(value: unknown, code: string): asserts value {
  if (!value) throw new ExtractionFenceError(code);
}
function sha(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function sourceId(runId: string, index: number) {
  const h = sha(`wine-extraction@1:${runId}:${index}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function remap(
  identity: ProductIdentity,
  ids: Map<string, string>,
): ProductIdentity {
  const copy = structuredClone(identity);
  for (const observation of [
    ...Object.values(copy.observations),
    ...Object.values(copy.category),
  ])
    if (observation)
      observation.evidenceIds = observation.evidenceIds.map((id) => {
        const mapped = ids.get(id);
        requireValid(mapped, "extraction_source_reference_invalid");
        return mapped;
      });
  return copy;
}
async function fence(r: WorkspaceRepositories, c: WineStageContext) {
  requireValid(
    c.schemaVersion === 1 &&
      c.job.stage === "extraction" &&
      c.dependencies.length === 0,
    "extraction_context_invalid",
  );
  await r.pipelineRuns.lockOperation(c.job.runId);
  const run = await r.pipelineRuns.getOperation(c.job.runId);
  requireValid(
    run &&
      run.id === c.run.id &&
      run.inputRevision === c.run.inputRevision &&
      run.listingId === c.run.listingId &&
      run.baseVersionId === c.run.baseVersionId &&
      run.activeVersionSequence === c.run.activeVersionSequence &&
      run.acceptedAt === c.run.acceptedAt &&
      run.listingId === c.job.draftId &&
      run.inputRevision === c.job.inputRevision &&
      run.activeVersionSequence === c.job.activeVersionSequence &&
      listingInputDigest(run.execution) === listingInputDigest(c.run.execution),
    "extraction_context_invalid",
  );
  requireValid(
    run.execution.flowVersion === "wine-enrichment-v1" &&
      ["full", "research"].includes(String(run.execution.wineMode)),
    "extraction_context_invalid",
  );
  const listing = await r.listings.getById(run.listingId),
    current = await r.pipelineRuns.getCurrentOperation(run.listingId);
  requireValid(
    ["queued", "running"].includes(run.executionState) &&
      listing?.inputRevision === run.inputRevision &&
      listing.activeVersionId === run.baseVersionId &&
      current?.id === run.id,
    "extraction_operation_stale",
  );
  const stage = await r.wineEnrichment.readStage(run.id, "extraction");
  requireValid(
    stage?.state === "started" &&
      stage.dependencyDigest === c.dependencyDigest &&
      stage.inputDigest === run.execution.wineInputDigest,
    "extraction_checkpoint_invalid",
  );
  const input = await r.listingInputs.getRevision(
    run.listingId,
    run.inputRevision,
  );
  const snapshot = run.execution.input as Record<string, unknown>;
  requireValid(
    input &&
      input.workspaceId === c.job.workspaceId &&
      input.inputDigest === run.execution.wineInputDigest &&
      listingInputDigest(input.sources) === run.execution.wineSourceDigest,
    "extraction_input_invalid",
  );
  for (const key of [
    "note",
    "sources",
    "fieldStates",
    "workingContent",
  ] as const)
    requireValid(
      listingInputDigest(input[key]) === listingInputDigest(snapshot[key]),
      "extraction_input_invalid",
    );
  const now = await r.pipelineRuns.acceptanceTimestamp();
  const deadline = (run.execution.wineAcquisition as { deadlineAt: string })
    .deadlineAt;
  requireValid(
    Date.parse(now) >= Date.parse(run.acceptedAt) &&
      Date.parse(now) < Date.parse(deadline),
    "extraction_deadline",
  );
  return { run, input, now };
}
/** Invoke only through runWineStage; this handler independently reloads its started server checkpoint. */
export function createWineExtractionHandler(
  config: WineExtractionConfig,
): WineStageExecutor {
  return async (raw) => {
    const c = structuredClone(raw);
    try {
      const initial = await config.database.forWorkspace(
        c.job.workspaceId,
        async (r) => {
          const f = await fence(r, c);
          const selected = f.input.sources.filter(
            (s) => s.use === "analyse" && s.role !== "supplier_document",
          );
          const assets = await r.sourceAssets.getByIds(
            selected.map((s) => s.assetId),
          );
          requireValid(
            assets.length === selected.length,
            "extraction_asset_missing",
          );
          const ordered = selected.map((s) => {
            const asset = assets.find((a) => a.id === s.assetId)!;
            const metadata = asset.metadata as Record<string, unknown>;
            requireValid(
              asset.workspaceId === c.job.workspaceId &&
                asset.listingId === c.run.listingId &&
                ["image/jpeg", "image/png", "image/webp"].includes(
                  asset.kind,
                ) &&
                (metadata.sha256 ?? metadata.clientSha256) === s.digest,
              "extraction_asset_invalid",
            );
            return { asset, digest: s.digest };
          });
          return { ...f, selected: ordered };
        },
      );
      const assets = [];
      for (const selected of initial.selected) {
        const resolved = await config.resolveImage(
          structuredClone(selected.asset),
        );
        requireValid(
          sha(resolved.bytes) === selected.digest,
          "extraction_asset_digest_invalid",
        );
        assets.push({
          id: selected.asset.id,
          mimeType: selected.asset.kind,
          readUrl: resolved.readUrl,
        });
      }
      // Recheck after storage I/O. The actual Go adapter separately commits its per-call guard.
      await config.database.forWorkspace(c.job.workspaceId, (r) => fence(r, c));
      const provider = wineOperationAI(
        config.database,
        config.env,
        c.job.workspaceId,
        initial.run,
        config.transport,
      );
      const extracted = await provider.extract({
        assets,
        note: initial.input.note,
      });
      return await config.database.forWorkspace(
        c.job.workspaceId,
        async (r) => {
          const f = await fence(r, c),
            binding = {
              workspaceId: c.job.workspaceId,
              operationId: c.run.id,
              inputRevision: c.run.inputRevision,
            };
          const ids = new Map(
            extracted.evidence.map((s, i) => [s.id, sourceId(c.run.id, i)]),
          );
          const identity = remap(extracted.identity, ids);
          const records = extracted.evidence.map((source, index) => {
            const asset =
              source.kind === "photo"
                ? initial.selected.find((s) => s.asset.id === source.assetId)
                : null;
            requireValid(
              source.kind !== "photo" || asset,
              "extraction_asset_invalid",
            );
            const documentDigest = "sha256:" + sha(source.excerpt);
            return {
              binding,
              assetDigest: asset?.digest ?? null,
              documentDigest,
              source: {
                ...source,
                id: ids.get(source.id)!,
                capturedAt: f.now,
                documentDigest,
                location: `wine:extraction:${c.run.id}:transcript:${index}`,
                trust: "unverified" as const,
                independenceKey:
                  source.kind === "photo"
                    ? `asset:${asset!.digest}`
                    : `merchant:${c.run.id}`,
                identity: source.identity ? remap(source.identity, ids) : null,
              },
            };
          });
          const lockedFields = Object.entries(f.input.fieldStates)
            .filter(([, v]) => v?.locked || v?.owner === "operator")
            .map(([key]) => key);
          const grounded = groundWineEvidence({
            accepted: {
              binding,
              assets: initial.selected.map((s) => ({
                id: s.asset.id,
                digest: s.digest,
              })),
              note: f.input.note,
              lockedFields,
              verifiedAliases: [],
            },
            extraction: { binding, identity },
            records,
            authorities: await r.wineEnrichment.readAuthorities(),
            now: f.now,
          });
          const context = grounded.context;
          // Immutable evidence is sanitized before its FIRST insertion; no raw-then-update cycle.
          await fence(r, c);
          await r.wineEnrichment.saveEvidence(c.run.id, context.sources);
          await r.wineEnrichment.saveTrustedContext({
            runId: c.run.id,
            contextKey: WINE_EXTRACTION_CONTEXT_KEY,
            inputDigest: String(f.run.execution.wineInputDigest),
            context: {
              schemaVersion: 1,
              identity: context.identity,
              policyVersion: (
                f.run.execution.wineAcquisition as { policyVersion: string }
              ).policyVersion,
              authorities: context.authorities,
              supports: context.supports,
              reliableSourceIds: context.reliableSourceIds,
              trustedObservationSourceIds: context.trustedObservationSourceIds,
              acceptedPremises: context.acceptedPremises,
              verifiedAliases: context.verifiedAliases,
            },
          });
          return {
            schemaVersion: 1 as const,
            stage: "extraction" as const,
            state: "succeeded" as const,
            observedAt: f.now,
            identity: context.identity,
            evidence: context.sources,
            issues: grounded.issues,
          };
        },
      );
    } catch (error) {
      return {
        schemaVersion: 1,
        stage: "extraction",
        state: error instanceof ExtractionFenceError ? "blocked" : "unknown",
        code:
          error instanceof ExtractionFenceError
            ? error.message
            : "extraction_outcome_unknown",
      };
    }
  };
}

/** Loads only committed same-run extraction provenance; later research must retain this pool and its diagnostics. */
export async function readWineExtractionContext(
  database: Pick<Database, "forWorkspace">,
  raw: WineStageContext,
): Promise<import("./wine-evidence-grounding.js").WineGroundingResult> {
  const c = structuredClone(raw);
  return database.forWorkspace(c.job.workspaceId, async (r) => {
    const run = await r.pipelineRuns.getOperation(c.job.runId);
    requireValid(
      run &&
        run.id === c.run.id &&
        run.inputRevision === c.run.inputRevision &&
        run.listingId === c.run.listingId &&
        run.baseVersionId === c.run.baseVersionId &&
        run.activeVersionSequence === c.run.activeVersionSequence &&
        run.acceptedAt === c.run.acceptedAt &&
        run.listingId === c.job.draftId &&
        run.inputRevision === c.job.inputRevision &&
        listingInputDigest(run.execution) ===
          listingInputDigest(c.run.execution),
      "extraction_context_invalid",
    );
    const stage = await r.wineEnrichment.readStage(run.id, "extraction"),
      dependency = c.dependencies.find((s) => s.stage === "extraction");
    requireValid(
      stage &&
        dependency &&
        listingInputDigest(stage) === listingInputDigest(dependency) &&
        stage.runId === run.id &&
        stage.state === "succeeded" &&
        stage.inputDigest === run.execution.wineInputDigest,
      "extraction_checkpoint_invalid",
    );
    const expected = wineStageDependencyDigest(run, []);
    requireValid(
      stage.dependencyDigest === expected,
      "extraction_checkpoint_invalid",
    );
    const wrapper = stage.output as {
      schemaVersion: number;
      fresh: boolean;
      result: unknown;
    };
    requireValid(
      wrapper.schemaVersion === 1 && wrapper.fresh === true,
      "extraction_checkpoint_invalid",
    );
    const result = parseWineStageResult(wrapper.result, "extraction");
    requireValid(
      result.state === "succeeded" && result.stage === "extraction",
      "extraction_checkpoint_invalid",
    );
    const input = await r.listingInputs.getRevision(
      run.listingId,
      run.inputRevision,
    );
    requireValid(
      input &&
        input.workspaceId === c.job.workspaceId &&
        input.inputDigest === stage.inputDigest &&
        listingInputDigest(input.sources) === run.execution.wineSourceDigest,
      "extraction_input_invalid",
    );
    const saved = await r.wineEnrichment.readTrustedContext(
      run.id,
      WINE_EXTRACTION_CONTEXT_KEY,
      stage.inputDigest,
    );
    requireValid(
      saved &&
        saved.policyVersion ===
          (run.execution.wineAcquisition as { policyVersion: string })
            .policyVersion &&
        listingInputDigest(saved.identity) ===
          listingInputDigest(result.identity),
      "extraction_trusted_context_invalid",
    );
    const rows = await r.wineEnrichment.readEvidence(run.id),
      binding = {
        workspaceId: c.job.workspaceId,
        operationId: run.id,
        inputRevision: run.inputRevision,
      };
    const assets = input.sources
      .filter((s) => s.use === "analyse" && s.role !== "supplier_document")
      .map((s) => ({ id: s.assetId, digest: s.digest }));
    const records = result.evidence.map((source, index) => {
      const row = rows.find((s) => s.id === source.id);
      requireValid(
        row &&
          listingInputDigest(row) === listingInputDigest(source) &&
          row.id === sourceId(run.id, index) &&
          row.kind !== "web" &&
          row.url === null &&
          row.domain === null &&
          row.capturedAt === result.observedAt &&
          row.documentDigest === "sha256:" + sha(row.excerpt) &&
          row.location === `wine:extraction:${run.id}:transcript:${index}`,
        "extraction_source_checkpoint_invalid",
      );
      const asset =
        row.kind === "photo" ? assets.find((a) => a.id === row.assetId) : null;
      requireValid(row.kind !== "photo" || asset, "extraction_asset_invalid");
      requireValid(
        row.independenceKey ===
          (row.kind === "photo"
            ? `asset:${asset!.digest}`
            : `merchant:${run.id}`),
        "extraction_source_checkpoint_invalid",
      );
      return {
        binding,
        assetDigest: asset?.digest ?? null,
        documentDigest: row.documentDigest,
        source: row,
      };
    });
    requireValid(
      Date.parse(result.observedAt) >= Date.parse(run.acceptedAt) &&
        Date.parse(result.observedAt) <
          Date.parse(
            (run.execution.wineAcquisition as { deadlineAt: string })
              .deadlineAt,
          ),
      "extraction_observation_time_invalid",
    );
    const lockedFields = Object.entries(input.fieldStates)
      .filter(([, v]) => v?.locked || v?.owner === "operator")
      .map(([key]) => key);
    const rebuilt = groundWineEvidence({
      accepted: {
        binding,
        assets,
        note: input.note,
        lockedFields,
        verifiedAliases: saved.verifiedAliases,
      },
      extraction: { binding, identity: result.identity },
      records,
      authorities: saved.authorities,
      now: result.observedAt,
    });
    for (const key of [
      "supports",
      "reliableSourceIds",
      "trustedObservationSourceIds",
      "acceptedPremises",
    ] as const)
      requireValid(
        listingInputDigest(
          saved[key].map((v) => listingInputDigest(v)).sort(),
        ) ===
          listingInputDigest(
            rebuilt.context[key].map((v) => listingInputDigest(v)).sort(),
          ),
        "extraction_trusted_context_invalid",
      );
    // Re-grounding sanitized observations cannot regenerate invalid raw hints: preserve committed diagnostics exactly.
    return { context: rebuilt.context, issues: structuredClone(result.issues) };
  });
}

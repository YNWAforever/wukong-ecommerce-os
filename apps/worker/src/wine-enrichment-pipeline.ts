import {
  productIdentitySchema,
  evidenceSourceSchema,
  supportedClaimSchema,
  wineContentSchema,
  type ProductIdentity,
  type EvidenceSource,
  type SupportedClaim,
  type WineContent,
  type WineStage,
  type QualityIssue,
} from "@wukong/core";
import { wineQualityIssueSchema } from "@wukong/ai";
import { wineListingJobSchema, type WineListingJob } from "@wukong/jobs";
import type { ListingOperation, StageRecord } from "@wukong/db";

export const WINE_STAGE_ORDER: readonly WineStage[] = [
  "extraction",
  "search_basic",
  "verification",
  "search_deep",
  "verification_deep",
  "generation",
  "quality_check",
  "commit_candidate",
];
type Success<S extends WineStage, T> = {
  schemaVersion: 1;
  state: "succeeded";
  stage: S;
} & T;
/** Server-validated stage artifacts. Raw model proposals must be bound by the 8b handlers first. */
export type WineStageResult =
  | Success<
      "extraction",
      {
        identity: ProductIdentity;
        evidence: EvidenceSource[];
        issues: QualityIssue[];
      }
    >
  | Success<
      "search_basic" | "search_deep",
      { evidence: EvidenceSource[]; partial: boolean; issues: QualityIssue[] }
    >
  | Success<
      "verification" | "verification_deep",
      {
        identity: ProductIdentity;
        claims: SupportedClaim[];
        needsDeepSearch: boolean;
        deepSearchReasons: ("identity_gap" | "core_fact_gap" | "conflict")[];
        issues: QualityIssue[];
      }
    >
  | Success<"generation", { content: WineContent; issues: QualityIssue[] }>
  | Success<
      "quality_check",
      {
        contentDigest: string;
        outcome: "ready" | "needs_info";
        issues: QualityIssue[];
      }
    >
  | Success<
      "commit_candidate",
      { versionId: string | null; outcome: "complete" | "needs_info" }
    >
  | {
      schemaVersion: 1;
      state: "blocked" | "unknown";
      stage: WineStage;
      code: string;
    };
export type WineStageContext = {
  schemaVersion: 1;
  job: WineListingJob;
  run: ListingOperation;
  dependencyDigest: string;
  dependencies: StageRecord[];
};
export type WineDeliveryResult =
  | { status: "advanced"; nextStage: WineStage }
  | { status: "duplicate" }
  | {
      status: "completed";
      versionId: string | null;
      outcome: "complete" | "needs_info";
    }
  | { status: "blocked" | "stopped"; code: string };
export type WineClaim =
  WineDeliveryResult | { status: "claimed"; context: WineStageContext };
export type WineStageStore = {
  claim(job: WineListingJob): Promise<WineClaim>;
  finish(
    context: WineStageContext,
    result: WineStageResult,
  ): Promise<WineDeliveryResult>;
  commitCandidate(context: WineStageContext): Promise<WineDeliveryResult>;
};
export type WineStageExecutor = (
  context: WineStageContext,
) => Promise<WineStageResult>;
function strictKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in value))
  )
    throw Error("invalid stage output keys");
}
export function parseWineStageResult(
  raw: unknown,
  stage: WineStage,
): WineStageResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("invalid stage output");
  const r = raw as Record<string, unknown>,
    base = ["schemaVersion", "state", "stage"];
  if (r.schemaVersion !== 1 || r.stage !== stage)
    throw Error("stage output binding mismatch");
  if (r.state === "blocked" || r.state === "unknown") {
    strictKeys(r, [...base, "code"]);
    if (typeof r.code !== "string" || !r.code || r.code.length > 128)
      throw Error("invalid stage code");
    return structuredClone(r) as WineStageResult;
  }
  if (r.state !== "succeeded") throw Error("invalid stage outcome");
  const keys: Record<WineStage, string[]> = {
    extraction: ["identity", "evidence", "issues"],
    search_basic: ["evidence", "partial", "issues"],
    verification: [
      "identity",
      "claims",
      "needsDeepSearch",
      "deepSearchReasons",
      "issues",
    ],
    search_deep: ["evidence", "partial", "issues"],
    verification_deep: [
      "identity",
      "claims",
      "needsDeepSearch",
      "deepSearchReasons",
      "issues",
    ],
    generation: ["content", "issues"],
    quality_check: ["contentDigest", "outcome", "issues"],
    commit_candidate: ["versionId", "outcome"],
  };
  strictKeys(r, [...base, ...keys[stage]]);
  if ("identity" in r) productIdentitySchema.parse(r.identity);
  if ("evidence" in r) evidenceSourceSchema.array().parse(r.evidence);
  if ("claims" in r) supportedClaimSchema.array().parse(r.claims);
  if ("content" in r) wineContentSchema.parse(r.content);
  if ("issues" in r) wineQualityIssueSchema.array().parse(r.issues);
  if ("partial" in r && typeof r.partial !== "boolean")
    throw Error("invalid partial flag");
  if ("needsDeepSearch" in r && typeof r.needsDeepSearch !== "boolean")
    throw Error("invalid deep decision");
  if ("needsDeepSearch" in r) {
    const reasons = r.deepSearchReasons;
    if (
      !Array.isArray(reasons) ||
      reasons.length > 3 ||
      reasons.some(
        (x) => !["identity_gap", "core_fact_gap", "conflict"].includes(x),
      ) ||
      new Set(reasons).size !== reasons.length ||
      Boolean(reasons.length) !== r.needsDeepSearch
    )
      throw Error("invalid deterministic deep decision");
  }
  if (
    stage === "quality_check" &&
    (!["ready", "needs_info"].includes(String(r.outcome)) ||
      typeof r.contentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(r.contentDigest))
  )
    throw Error("invalid quality result");
  if (
    stage === "commit_candidate" &&
    (!["complete", "needs_info"].includes(String(r.outcome)) ||
      (r.versionId !== null &&
        (typeof r.versionId !== "string" ||
          !wineListingJobSchema.shape.runId.safeParse(r.versionId).success)) ||
      (r.outcome === "complete" && r.versionId === null))
  )
    throw Error("invalid projection result");
  return structuredClone(r) as WineStageResult;
}
/** A delivery owns one stage. Awaiting claim has already COMMITTED before execute. */
export async function runWineStage(
  raw: WineListingJob,
  deps: { store: WineStageStore; execute: WineStageExecutor },
): Promise<WineDeliveryResult> {
  const job = wineListingJobSchema.parse(raw),
    claim = await deps.store.claim(job);
  if (claim.status !== "claimed") return claim;
  if (job.stage === "commit_candidate")
    return deps.store.commitCandidate(claim.context);
  let result: WineStageResult;
  try {
    result = parseWineStageResult(
      await deps.execute(structuredClone(claim.context)),
      job.stage,
    );
  } catch {
    result = {
      schemaVersion: 1,
      state: "unknown",
      stage: job.stage,
      code: "stage_execution_unknown",
    };
  }
  // A DB failure is propagated, never converted into a fresh execution attempt.
  return deps.store.finish(claim.context, result);
}

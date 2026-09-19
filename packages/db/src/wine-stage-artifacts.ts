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
import {
  wineQualityIssueSchema,
  wineFrozenContextSchema,
  type WineFrozenContext,
  wineGenerationRequestSchema,
  wineGenerationCandidateSchema,
  type WineGenerationRequest,
  type WineGenerationCandidate,
} from "@wukong/core";
import { listingInputDigest } from "./repositories/listing-inputs.js";
import { wineListingJobSchema } from "@wukong/jobs";
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
        observedAt: string;
        identity: ProductIdentity;
        evidence: EvidenceSource[];
        issues: QualityIssue[];
      }
    >
  | Success<
      "search_basic" | "search_deep",
      {
        evidence: EvidenceSource[];
        partial: boolean;
        issues: QualityIssue[];
        cacheOrigin?: { schemaVersion: 1; runId: string; snapshotId: string };
      }
    >
  | Success<
      "verification" | "verification_deep",
      {
        identity: ProductIdentity;
        claims: SupportedClaim[];
        frozenVerification?: WineFrozenContext;
        needsDeepSearch: boolean;
        deepSearchReasons: ("identity_gap" | "core_fact_gap" | "conflict")[];
        issues: QualityIssue[];
      }
    >
  | Success<
      "generation",
      {
        content: WineContent;
        issues: QualityIssue[];
        /** Required by semantic quality handlers; optional for older lifecycle checkpoints. */
        frozenQuality?: {
          schemaVersion: 1;
          request: WineGenerationRequest;
          candidate: WineGenerationCandidate;
        };
      }
    >
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
    extraction: ["observedAt", "identity", "evidence", "issues"],
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
  if (["search_basic", "search_deep"].includes(stage) && "cacheOrigin" in r) {
    const origin = r.cacheOrigin;
    if (!origin || typeof origin !== "object" || Array.isArray(origin))
      throw Error("invalid cache origin");
    const value = origin as Record<string, unknown>;
    strictKeys(value, ["schemaVersion", "runId", "snapshotId"]);
    if (
      value.schemaVersion !== 1 ||
      !wineListingJobSchema.shape.runId.safeParse(value.runId).success ||
      !wineListingJobSchema.shape.runId.safeParse(value.snapshotId).success
    )
      throw Error("invalid cache origin");
    keys[stage].push("cacheOrigin");
  }
  if (
    (stage === "verification" || stage === "verification_deep") &&
    "frozenVerification" in r
  ) {
    wineFrozenContextSchema.parse(r.frozenVerification);
    keys[stage].push("frozenVerification");
  }
  if (stage === "generation" && "frozenQuality" in r) {
    const frozen = r.frozenQuality;
    if (!frozen || typeof frozen !== "object" || Array.isArray(frozen))
      throw Error("invalid frozen quality artifact");
    const value = frozen as Record<string, unknown>;
    strictKeys(value, ["schemaVersion", "request", "candidate"]);
    if (value.schemaVersion !== 1)
      throw Error("invalid frozen quality artifact");
    wineGenerationRequestSchema.parse(value.request);
    const candidate = wineGenerationCandidateSchema.parse(value.candidate);
    if (listingInputDigest(candidate.content) !== listingInputDigest(r.content))
      throw Error("generation content mismatch");
    keys.generation.push("frozenQuality");
  }
  strictKeys(r, [...base, ...keys[stage]]);
  if (
    stage === "extraction" &&
    (typeof r.observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.observedAt) ||
      !Number.isFinite(Date.parse(r.observedAt)) ||
      new Date(r.observedAt).toISOString() !== r.observedAt)
  )
    throw Error("invalid extraction observation time");
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

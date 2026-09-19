import { normalizeWebsiteUrl } from "@wukong/core";
import type {
  EvidenceSource,
  ProductIdentity,
  QualityIssue,
  WineContent,
  WineStage,
} from "@wukong/core";
import {
  parseWineStageResult,
  wineStageOrder,
  wineStageDependencyDigest,
  type ListingOperation,
  type StageRecord,
  type WorkspaceRepositories,
  type WineStageResult,
} from "@wukong/db";
export type WineProgress = {
  runId: string;
  inputRevision: number;
  stage: WineStage | null;
  state:
    | "queued"
    | "running"
    | "needs_info"
    | "in_review"
    | "failed"
    | "superseded"
    | "cancelled";
  completedStages: WineStage[];
  candidates: {
    id: string;
    runId: string;
    stage: WineStage;
    identity: ProductIdentity;
    confirmationAvailable: false;
  }[];
  identity: ProductIdentity | null;
  issues: QualityIssue[];
  evidence: {
    id: string;
    kind: EvidenceSource["kind"];
    title: string;
    excerpt: string;
    url: string | null;
    contentScope: EvidenceSource["contentScope"];
    linkStatus: "available" | "unavailable" | "not_applicable";
    capturedAt: string;
    truncated: boolean;
  }[];
  inspection: {
    stage: WineStage;
    status: "fresh" | "stale" | "rejected";
    content: WineContent;
  }[];
  enrichment: "complete" | "partial" | "unavailable";
  goEstimatedUsd: string | null;
  tavilyCredits: number | null;
};
// URLs embedded in model prose are not approved hyperlinks; secrets must not survive in display text.
function safeText(text: string): string {
  return (
    text
      // Match scheme AND credential before the single-value fallback can consume the scheme alone.
      .replace(
        /\b(?:proxy-)?authorization[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|apikey|negotiate)[ \t]+[a-z0-9._~+/-]+=*["']?|(?:digest|aws4-hmac-sha256)[ \t]+[^\r\n]+)/gi,
        "[redacted]",
      )
      // Bare Bearer token68 credentials occur in copied snippets. Preserve ordinary "bearer of" prose.
      .replace(
        /(?<![\w-])bearer[ \t]+(?!of\b)["']?[a-z0-9._~+/-]+=*["']?/gi,
        "[redacted]",
      )
      .replace(/(?:https?|s3|file):\/\/[^\s<>"']+/gi, "[link removed]")
      .replace(/\b(?:sk|tvly|key)-[a-z0-9_-]{8,}\b/gi, "[redacted]")
      .replace(
        /\b(?:api[_ -]?key|authorization|bearer|secret|token)\s*[:=]\s*[^\s,;]+/gi,
        "[redacted]",
      )
  );
}
function display<T>(value: T): T {
  if (typeof value === "string") return safeText(value) as T;
  if (Array.isArray(value)) return value.map(display) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, display(v)]),
    ) as T;
  return value;
}
function publicLink(source: EvidenceSource, allowed: unknown): string | null {
  if (source.kind !== "web" || !source.url || !Array.isArray(allowed))
    return null;
  const normalized = normalizeWebsiteUrl(source.url);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (source.domain !== url.hostname || !allowed.includes(url.hostname))
      return null;
    const path = decodeURIComponent(url.pathname);
    if (
      /[\u0000-\u0020\\]/.test(path) ||
      /(?:^|\/)(?:private|signed|token|auth|account)(?:\/|$)/i.test(path) ||
      safeText(path) !== path
    )
      return null;
    const selectors = new Set([
      "id",
      "page",
      "lang",
      "variant",
      "product",
      "sku",
    ]);
    for (const [key, value] of [...url.searchParams]) {
      if (
        /^utm_[a-z_]+$/.test(key) ||
        ["gclid", "fbclid", "msclkid"].includes(key)
      ) {
        url.searchParams.delete(key);
      } else if (
        !selectors.has(key) ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(value) ||
        safeText(value) !== value
      )
        return null;
    }
    // Static display validation only. Acquisition owns DNS, redirect and robots checks.
    // Keep actual supporting-document identity; never substitute a publisher homepage.
    return url.href;
  } catch {
    return null;
  }
}
function parsed(raw: unknown, stage: WineStage): WineStageResult | null {
  try {
    return parseWineStageResult(raw, stage);
  } catch {
    return null;
  }
}
/** Persisted display only: this DTO never authorizes confirmation, adoption or publication. */
export async function readWineProgress(
  repos: WorkspaceRepositories,
  run: ListingOperation,
): Promise<WineProgress | null> {
  if (run.execution?.flowVersion !== "wine-enrichment-v1") return null;
  let order: readonly WineStage[];
  try {
    order = wineStageOrder(run.execution.wineMode);
  } catch {
    return null;
  }
  const rows = await Promise.all(
    order.map((stage) => repos.wineEnrichment.readStage(run.id, stage)),
  );
  const usage = await repos.wineEnrichment.readUsage(run.id);
  const progress: WineProgress = {
    runId: run.id,
    inputRevision: run.inputRevision,
    stage: null,
    state:
      run.executionState === "succeeded" ? "needs_info" : run.executionState,
    completedStages: [],
    candidates: [],
    identity: null,
    issues: [],
    evidence: [],
    inspection: [],
    enrichment: "unavailable",
    ...usage,
  };
  const prefix: StageRecord[] = [];
  let valid = true;
  let complete = false;
  let partial = false;
  for (let index = 0; index < order.length; index++) {
    const stage = order[index]!,
      row = rows[index];
    if (!row) {
      valid = false;
      continue;
    }
    const wrapper = row.output as {
      schemaVersion?: number;
      fresh?: boolean;
      result?: unknown;
      rejectedResult?: unknown;
      reason?: string;
    } | null;
    const result = parsed(wrapper?.result, stage);
    const bound =
      row.runId === run.id &&
      row.stage === stage &&
      row.inputDigest === run.execution.wineInputDigest;
    const fresh =
      valid &&
      bound &&
      row.dependencyDigest === wineStageDependencyDigest(run, prefix) &&
      row.state === "succeeded" &&
      wrapper?.schemaVersion === 1 &&
      wrapper.fresh === true &&
      result?.state === "succeeded";
    const previous = prefix.find((x) => x.stage === "verification");
    const verification = previous
      ? parsed((previous.output as { result: unknown }).result, "verification")
      : null;
    const skipped =
      valid &&
      bound &&
      row.dependencyDigest === wineStageDependencyDigest(run, prefix) &&
      row.state === "skipped" &&
      wrapper?.schemaVersion === 1 &&
      wrapper.reason === "deep_search_not_required" &&
      ["search_deep", "verification_deep"].includes(stage) &&
      verification?.state === "succeeded" &&
      verification.stage === "verification" &&
      !verification.needsDeepSearch;
    if (bound) progress.stage = stage;
    if (fresh || skipped) {
      prefix.push(row);
      progress.completedStages.push(stage);
    } else valid = false;
    if (bound && wrapper?.schemaVersion === 1) {
      const rejected =
        wrapper.fresh === false ? parsed(wrapper.rejectedResult, stage) : null;
      const inspect = rejected ?? result;
      if (inspect?.state === "succeeded" && inspect.stage === "generation")
        progress.inspection.push({
          stage,
          status: rejected ? "rejected" : fresh ? "fresh" : "stale",
          content: display(inspect.content),
        });
    }
    if (!fresh || result?.state !== "succeeded") continue;
    if ("identity" in result) progress.identity = display(result.identity);
    if ("issues" in result) progress.issues.push(...display(result.issues));
    if ("partial" in result && result.partial) partial = true;
    if ("evidence" in result)
      for (const source of result.evidence) {
        const url = publicLink(
          source,
          (run.execution.wineAcquisition as { allowedDomains?: unknown })
            ?.allowedDomains,
        );
        if (!progress.evidence.some((x) => x.id === source.id))
          progress.evidence.push({
            id: source.id,
            kind: source.kind,
            title: safeText(source.title),
            excerpt: safeText(source.excerpt),
            url,
            contentScope: source.contentScope,
            linkStatus:
              source.kind !== "web"
                ? "not_applicable"
                : url
                  ? "available"
                  : "unavailable",
            capturedAt: source.capturedAt,
            truncated: source.truncated,
          });
        if (
          source.identity &&
          !progress.candidates.some((x) => x.id === source.id)
        )
          progress.candidates.push({
            id: source.id,
            runId: run.id,
            stage,
            identity: display(source.identity),
            confirmationAvailable: false,
          });
      }
    if (result.stage === "commit_candidate")
      complete = result.outcome === "complete";
  }
  if (run.executionState === "succeeded")
    progress.state = complete ? "in_review" : "needs_info";
  progress.enrichment =
    complete && !partial
      ? "complete"
      : progress.completedStages.length
        ? "partial"
        : "unavailable";
  return progress;
}

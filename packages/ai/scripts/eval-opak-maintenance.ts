import { createHash } from "node:crypto";
import { readFile, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { contentFields, listingFactsSchema } from "@wukong/core";

export const ADAPTER_VERSION = "audit-fixtures-v1/opak-adapter-v1";
export const POLICY_VERSION = "opak-maintenance-acceptance-v1";
const evidenceFields = [
  "input_digest",
  "source_ids_and_excerpts",
  "model_and_prompt_version",
  "input_revision",
  "output",
  "manual_verdict",
  "latency_ms",
  "usage_certainty_and_cost",
] as const;
const ids = Array.from(
  { length: 12 },
  (_, index) => `AI${String(index + 1).padStart(2, "0")}`,
);
const commercial = ["sku", "priceHkd", "stockQuantity"] as const;
const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const inputKeys: Record<string, string[]> = {
  AI01: ["label", "search_result"],
  AI02: ["label", "page_metadata"],
  AI03: ["label"],
  AI04: ["label"],
  AI05: ["label", "conflicting_page"],
  AI06: ["supplier", "merchant", "conflicting_page"],
  AI07: ["label", "other_vintage_review", "operator_request"],
  AI08: ["supplier_text", "merchant"],
  AI09: ["note"],
  AI10: [
    "working_revision",
    "manual_fields",
    "locked_fields",
    "run_input_revision",
    "ai_candidate",
  ],
  AI11: ["supplier", "brand_rule"],
  AI12: ["supplier", "merchant"],
};
const partialFactSchema = listingFactsSchema
  .extend({ packQuantity: z.number().int().positive().nullable() })
  .partial()
  .strict();
const rawCase = z
  .object({
    id: z.string().regex(/^AI(?:0[1-9]|1[0-2])$/),
    title: z.string().min(1).max(500),
    inputs: z.record(z.string(), z.unknown()),
    expected_partial_facts: partialFactSchema,
    required_checks: z.array(z.string().min(1).max(2000)).min(1),
    status: z.literal("not_executed_live"),
    output_evidence_required: z.array(z.enum(evidenceFields)).length(8),
    split: z.enum(["development", "holdout"]).optional(),
  })
  .strict();
const rawFixtures = z
  .object({
    schema: z.literal("audit-fixtures-v1"),
    purpose: z.string().max(2000),
    synthetic: z.boolean(),
    production_execution_performed: z.literal(false),
    hard_fail_rules: z.array(z.string().min(1).max(2000)).min(1),
    cases: z.array(rawCase).length(12),
  })
  .strict();
export type Facts = Record<string, unknown>;
export type MaintenanceCase = {
  id: string;
  split: "development" | "holdout";
  kind: "text" | "vision" | "service";
  workspaceId: string;
  listingId: string;
  inputRevision: number;
  runInputRevision: number;
  sources: Array<{ id: string; digest: string; text: string }>;
  expectedFacts: Facts;
  merchantFacts: Facts;
  manualFields: Facts;
  lockedFields: string[];
  inputDigest: string;
};
export type MaintenanceCandidate = {
  workspaceId: string;
  listingId: string;
  inputRevision: number;
  sourceIds: string[];
  facts: Facts;
  patch: Facts;
  published: boolean;
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}
function assert(condition: unknown): asserts condition {
  if (!condition)
    throw new Error("Invalid audit-fixtures-v1 structure or mapping");
}
function partialFacts(value: unknown): Facts {
  return partialFactSchema.parse(value) as Facts;
}

/** Explicit audit adapter. Source text remains in memory; public evidence is metadata only. */
export function adaptAuditFixtures(raw: unknown): {
  cases: MaintenanceCase[];
  synthetic: boolean;
  fixtureDigest: string;
} {
  // Do not expose Zod errors: they may retain private input values.
  const parsed = rawFixtures.safeParse(raw);
  assert(parsed.success);
  const input = parsed.data;
  assert(new Set(input.cases.map((item) => item.id)).size === 12);
  const cases = [...input.cases]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => {
      assert(
        same(Object.keys(item.inputs).sort(), [...inputKeys[item.id]!].sort()),
      );
      assert(new Set(item.output_evidence_required).size === 8);
      let merchantFacts: Facts = {},
        manualFields: Facts = {},
        lockedFields: string[] = [];
      let inputRevision = 1,
        runInputRevision = 1;
      for (const [key, value] of Object.entries(item.inputs)) {
        if (key === "merchant") {
          const result = z
            .object({
              sku: z.string().min(1),
              priceHkd: z.number().nonnegative(),
              stockQuantity: z.number().int().nonnegative(),
            })
            .strict()
            .safeParse(value);
          assert(result.success);
          merchantFacts = result.data;
        } else if (key === "manual_fields" || key === "ai_candidate") {
          const result = partialFactSchema.safeParse(value);
          assert(result.success);
          if (key === "manual_fields") manualFields = result.data as Facts;
        } else if (key === "locked_fields") {
          const result = z
            .array(
              z.enum(
                Object.keys(listingFactsSchema.shape) as [string, ...string[]],
              ),
            )
            .safeParse(value);
          assert(result.success);
          lockedFields = result.data;
          assert(new Set(lockedFields).size === lockedFields.length);
        } else if (key === "working_revision" || key === "run_input_revision") {
          assert(
            typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value > 0,
          );
          if (key === "working_revision") inputRevision = value;
          else runInputRevision = value;
        } else
          assert(
            typeof value === "string" &&
              value.length > 0 &&
              value.length <= 16000,
          );
      }
      const expectedFacts = partialFacts(item.expected_partial_facts);
      for (const [key, value] of Object.entries(merchantFacts))
        if (key in expectedFacts) assert(same(expectedFacts[key], value));
      for (const field of lockedFields)
        assert(
          field in manualFields &&
            same(expectedFacts[field], manualFields[field]),
        );
      const sources = Object.entries(item.inputs)
        .filter(
          ([key]) =>
            ![
              "working_revision",
              "run_input_revision",
              "locked_fields",
              "manual_fields",
              "ai_candidate",
            ].includes(key),
        )
        .map(([key, value]) => ({
          id: `${item.id}:${key}`,
          digest: digest(value),
          text: typeof value === "string" ? value : stable(value),
        }));
      return {
        id: item.id,
        split:
          item.split ??
          (item.id === "AI07" || item.id === "AI11"
            ? "holdout"
            : "development"),
        kind:
          item.id === "AI09"
            ? "vision"
            : item.id === "AI10"
              ? "service"
              : "text",
        workspaceId: "opak-eval-workspace",
        listingId: `opak-eval-${item.id}`,
        inputRevision,
        runInputRevision,
        sources,
        expectedFacts,
        merchantFacts,
        manualFields,
        lockedFields,
        inputDigest: digest({ inputs: item.inputs, inputRevision }),
      } satisfies MaintenanceCase;
    });
  assert(
    same(
      cases.map((item) => item.id),
      ids,
    ),
  );
  return { cases, synthetic: input.synthetic, fixtureDigest: digest(input) };
}

/** These are hard invariants, not a semantic accuracy/quality score. */
export function checkMaintenanceCandidate(
  item: MaintenanceCase,
  candidate: MaintenanceCandidate,
): string[] {
  const failures: string[] = [];
  if (candidate.workspaceId !== item.workspaceId)
    failures.push("cross_workspace");
  if (candidate.listingId !== item.listingId) failures.push("foreign_listing");
  if (candidate.inputRevision !== item.inputRevision)
    failures.push("stale_revision");
  const allowedSources = new Set(item.sources.map((source) => source.id));
  if (
    !Array.isArray(candidate.sourceIds) ||
    new Set(candidate.sourceIds).size !== candidate.sourceIds.length ||
    candidate.sourceIds.length !== allowedSources.size ||
    candidate.sourceIds.some((id) => !allowedSources.has(id))
  )
    failures.push("source_changed");
  if (candidate.published !== false) failures.push("unapproved_publication");
  if (
    Object.keys(candidate.facts).some(
      (key) => !(key in listingFactsSchema.shape),
    )
  )
    failures.push("forbidden_fact_field");
  if (!partialFactSchema.safeParse(candidate.facts).success)
    failures.push("invalid_fact_value");
  if (
    Object.keys(candidate.patch).some(
      (key) => !(contentFields as readonly string[]).includes(key),
    )
  )
    failures.push("forbidden_copy_field");
  for (const [key, value] of Object.entries(candidate.patch)) {
    if (
      (contentFields as readonly string[]).includes(key) &&
      (key === "seoKeywords"
        ? !Array.isArray(value) ||
          value.some((entry) => typeof entry !== "string")
        : typeof value !== "string")
    )
      failures.push("invalid_copy_value");
  }
  for (const [field, expected] of Object.entries(item.expectedFacts)) {
    if (!same(candidate.facts[field], expected))
      failures.push(
        `${(commercial as readonly string[]).includes(field) ? "commercial_changed" : "fact_mismatch"}:${field}`,
      );
  }
  for (const field of commercial) {
    const baseline =
      item.merchantFacts[field] ?? item.expectedFacts[field] ?? null;
    if (!same(candidate.facts[field] ?? null, baseline))
      failures.push(`commercial_changed:${field}`);
  }
  for (const field of item.lockedFields)
    if (!same(candidate.facts[field], item.manualFields[field]))
      failures.push(`manual_lock_changed:${field}`);
  if (
    !same(
      candidate.facts.criticScores ?? [],
      item.expectedFacts.criticScores ?? [],
    )
  )
    failures.push("unsupported_rating");
  if (!same(candidate.facts.awards ?? [], item.expectedFacts.awards ?? []))
    failures.push("unsupported_award");
  const copy = stable(candidate.patch);
  if (
    !(item.expectedFacts.criticScores as unknown[] | undefined)?.length &&
    /\b\d{2,3}\s*(?:points?|pts?)\b|\b(?:rated|rating|scored)\b|[0-9]{2,3}分/i.test(
      copy,
    )
  )
    failures.push("unsupported_rating_copy");
  if (
    !(item.expectedFacts.awards as unknown[] | undefined)?.length &&
    /\b(?:award[- ]winning|gold medal|silver medal|trophy winner)\b|獲獎|金獎|銀獎/i.test(
      copy,
    )
  )
    failures.push("unsupported_award_copy");
  if (
    /\b(?:cures?|prevents?|treats?)\s+(?:disease|cancer|diabetes)|\bmedicinal\b|治療|療效|預防疾病/i.test(
      copy,
    )
  )
    failures.push("medical_claim");
  return [...new Set(failures)];
}
const humanSchema = z
  .object({
    reviewer: z.string().trim().min(1).max(200),
    reviewedAt: z.string().datetime(),
    identityFacts: z.number().min(0).max(35),
    sourceGrounding: z.number().min(0).max(20),
    bilingual: z.number().min(0).max(15),
    businessUsability: z.number().min(0).max(15),
    safety: z.number().min(0).max(15),
    hardFails: z.number().int().nonnegative(),
  })
  .strict();
export type HumanVerdict = z.infer<typeof humanSchema>;
export function gradeHumanVerdict(
  verdict: HumanVerdict | null,
  deterministicFailures: string[],
): {
  status: "pending" | "passed" | "failed";
  score: number | null;
  hardFails: number | null;
} {
  if (verdict === null)
    return { status: "pending", score: null, hardFails: null };
  const result = humanSchema.safeParse(verdict);
  if (!result.success) throw new Error("Invalid human verdict");
  const v = result.data,
    score =
      v.identityFacts +
      v.sourceGrounding +
      v.bilingual +
      v.businessUsability +
      v.safety;
  const hardFails = v.hardFails + deterministicFailures.length;
  return {
    status: score >= 90 && hardFails === 0 ? "passed" : "failed",
    score,
    hardFails,
  };
}
export type EvaluationAttempt = {
  candidate?: MaintenanceCandidate;
  providerRequests: number;
  model: string;
  promptVersions: string[];
  latencyMs: number;
  costUsd: number | null;
  costCertainty: "estimated" | "measured" | "unknown";
  failure?:
    | "provider_error"
    | "budget_exhausted"
    | "request_cap"
    | "input_bound"
    | "unknown_cost"
    | "incomplete_identity";
};
export type LiveConfig = {
  apiKey: string;
  model: string;
  pricingVersion: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: number;
  budgetUsd: number;
};
export type MaintenanceProvider = {
  evaluate(item: MaintenanceCase): Promise<EvaluationAttempt>;
};
type ReportItem = {
  id: string;
  split: string;
  kind: string;
  inputDigest: string;
  inputRevision: number;
  runInputRevision: number;
  sources: Array<{ id: string; digest: string }>;
  status: "mapped" | "blocked" | "candidate" | "failed";
  reason: string | null;
  model: string | null;
  promptVersions: string[];
  outputDigest: string | null;
  deterministicFailures: string[];
  humanVerdict: HumanVerdict | null;
  latencyMs: number | null;
  cost: {
    certainty: "not_incurred" | "estimated" | "measured" | "unknown";
    usd: number | null;
  };
  privateContent?: {
    sources: Array<{ id: string; text: string }>;
    output: MaintenanceCandidate | null;
  };
};
export type MaintenanceReport = {
  deterministicHarnessChecks: { status: "passed"; checks: number };
  schema: "opak-maintenance-evidence-v1";
  adapterVersion: string;
  policyVersion: string;
  fixtureDigest: string;
  synthetic: boolean;
  mode: "dry" | "live";
  status: "dry_run" | "blocked" | "completed" | "stopped";
  qualityStatus: "not_evaluated" | "human_review_required";
  providerRequests: number;
  blockers: string[];
  stopReason: string | null;
  pricingVersion: string | null;
  maxCostCeilingUsd: number | null;
  items: ReportItem[];
};
function options(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const flags = new Set([
    "dry-run",
    "confirm-authorized-data",
    "include-private-content",
  ]);
  const values = new Set([
    "mode",
    "budget-usd",
    "output",
    "fixtures",
    "max-requests",
    "split",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error("Invalid CLI option");
    const equal = arg.indexOf("="),
      key = arg.slice(2, equal < 0 ? undefined : equal);
    if (key in result || (!flags.has(key) && !values.has(key)))
      throw new Error("Invalid CLI option");
    if (flags.has(key)) {
      if (equal >= 0) throw new Error("Invalid CLI option");
      result[key] = true;
    } else {
      const value = equal >= 0 ? arg.slice(equal + 1) : args[++index];
      if (!value || value.startsWith("--"))
        throw new Error("Missing CLI option value");
      result[key] = value;
    }
  }
  return result;
}
function deterministicSelfChecks(cases: MaintenanceCase[]): {
  status: "passed";
  checks: number;
} {
  let checks = 0;
  for (const item of cases) {
    const valid: MaintenanceCandidate = {
      workspaceId: item.workspaceId,
      listingId: item.listingId,
      inputRevision: item.inputRevision,
      sourceIds: item.sources.map((source) => source.id),
      facts: { ...item.expectedFacts, ...item.merchantFacts },
      patch: { nameZh: "合成測試名稱" },
      published: false,
    };
    assert(checkMaintenanceCandidate(item, valid).length === 0);
    checks++;
    const invalid = {
      ...valid,
      workspaceId: "foreign",
      inputRevision: 0,
      sourceIds: ["foreign"],
      published: true,
      patch: { nameEn: "forbidden" },
    };
    const failures = checkMaintenanceCandidate(item, invalid);
    assert(
      [
        "cross_workspace",
        "stale_revision",
        "source_changed",
        "unapproved_publication",
        "forbidden_copy_field",
      ].every((code) => failures.includes(code)),
    );
    checks += 5;
    for (const [field, value] of Object.entries(item.expectedFacts)) {
      if (field === "criticScores" || field === "awards") continue;
      const mutation =
        typeof value === "number" ? value + 1 : value === null ? 1 : "mutated";
      assert(
        checkMaintenanceCandidate(item, {
          ...valid,
          facts: { ...valid.facts, [field]: mutation },
        }).some((code) => code.endsWith(`:${field}`)),
      );
      checks++;
    }
    if (item.kind === "service") {
      const late = {
        ...valid,
        inputRevision: item.runInputRevision,
        facts: {
          ...valid.facts,
          ...Object.fromEntries(
            item.lockedFields.map((field) => [field, null]),
          ),
        },
      };
      const failed = checkMaintenanceCandidate(item, late);
      assert(
        failed.includes("stale_revision") &&
          item.lockedFields.every((field) =>
            failed.includes(`manual_lock_changed:${field}`),
          ),
      );
      checks += 2;
    }
  }
  return { status: "passed", checks };
}
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
async function privateOutput(path: string) {
  const parent = await realpath(dirname(resolve(path))),
    root = await realpath(repoRoot),
    destination = join(parent, basename(path));
  const inside = relative(root, destination);
  const inRepo =
    inside === "" ||
    (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
  if (inRepo && !inside.startsWith(`node_modules${sep}.opak-evidence${sep}`))
    throw new Error(
      "Evidence output must be private and outside tracked repository paths",
    );
  return open(destination, "wx", 0o600);
}
function numeric(value: string | boolean | undefined): number {
  return typeof value === "string" && value.trim() ? Number(value) : NaN;
}
function liveConfig(
  opt: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
): { blockers: string[]; config: LiveConfig | null } {
  const blockers: string[] = [],
    budgetUsd = numeric(opt["budget-usd"]);
  if (!(budgetUsd > 0 && Number.isFinite(budgetUsd)))
    blockers.push("positive_budget_required");
  if (
    opt["confirm-authorized-data"] !== true ||
    env.OPAK_EVAL_LIVE_AUTHORIZED !== "1"
  )
    blockers.push("authorized_test_data_and_live_opt_in_required");
  if (env.OPAK_EVAL_PROVIDER !== "openai" || !env.OPENAI_API_KEY?.trim())
    blockers.push("provider_not_configured");
  const model = env.OPAK_EVAL_MODEL ?? "",
    pricingVersion = env.OPAK_EVAL_PRICING_VERSION ?? "";
  if (!safeVersion.test(model) || !/\d{4}-\d{2}-\d{2}$/.test(model))
    blockers.push("dated_model_pin_required");
  if (!safeVersion.test(pricingVersion))
    blockers.push("pricing_version_required");
  const inputUsdPerMillion = numeric(env.OPAK_EVAL_INPUT_USD_PER_MILLION),
    outputUsdPerMillion = numeric(env.OPAK_EVAL_OUTPUT_USD_PER_MILLION),
    maxInputTokens = numeric(env.OPAK_EVAL_MAX_INPUT_TOKENS);
  if (
    ![inputUsdPerMillion, outputUsdPerMillion].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    blockers.push("positive_explicit_pricing_required");
  if (
    !Number.isSafeInteger(maxInputTokens) ||
    maxInputTokens < 1 ||
    maxInputTokens > 1000000
  )
    blockers.push("bounded_input_required");
  const maxRequests =
    opt["max-requests"] === undefined ? 48 : numeric(opt["max-requests"]);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 48)
    blockers.push("request_cap_required");
  return {
    blockers,
    config: blockers.length
      ? null
      : {
          apiKey: env.OPENAI_API_KEY!,
          model,
          pricingVersion,
          inputUsdPerMillion,
          outputUsdPerMillion,
          maxInputTokens,
          maxOutputTokens: 4096,
          maxRequests,
          budgetUsd,
        },
  };
}

export async function runOpakMaintenanceCli(
  args: string[],
  env: Record<string, string | undefined>,
  deps: { providerFactory?: (config: LiveConfig) => MaintenanceProvider } = {},
): Promise<MaintenanceReport> {
  const opt = options(args),
    mode = opt["dry-run"] === true ? "dry" : (opt.mode ?? "dry");
  if (
    (mode !== "dry" && mode !== "live") ||
    (opt["dry-run"] && opt.mode === "live")
  )
    throw new Error("Invalid mode");
  if (typeof opt.output !== "string")
    throw new Error("A private --output file is required");
  if (mode === "dry" && opt["include-private-content"])
    throw new Error("Dry output is metadata only");
  const file = await privateOutput(opt.output);
  try {
    const path =
      typeof opt.fixtures === "string"
        ? opt.fixtures
        : fileURLToPath(
            new URL("../fixtures/opak-maintenance-v1.json", import.meta.url),
          );
    let raw: unknown;
    try {
      const input = await readFile(path, "utf8");
      if (Buffer.byteLength(input) > 1000000) throw new Error();
      raw = JSON.parse(input);
    } catch {
      throw new Error("Fixture input could not be read as bounded JSON");
    }
    const fixture = adaptAuditFixtures(raw),
      split = opt.split ?? "all";
    if (!["all", "development", "holdout"].includes(String(split)))
      throw new Error("Invalid fixture split");
    const cases = fixture.cases.filter(
      (item) => split === "all" || item.split === split,
    );
    const report: MaintenanceReport = {
      deterministicHarnessChecks: deterministicSelfChecks(cases),
      schema: "opak-maintenance-evidence-v1",
      adapterVersion: ADAPTER_VERSION,
      policyVersion: POLICY_VERSION,
      fixtureDigest: fixture.fixtureDigest,
      synthetic: fixture.synthetic,
      mode,
      status: mode === "dry" ? "dry_run" : "blocked",
      qualityStatus: "not_evaluated",
      providerRequests: 0,
      blockers: [],
      stopReason: null,
      pricingVersion: null,
      maxCostCeilingUsd: null,
      items: cases.map((item) => ({
        id: item.id,
        split: item.split,
        kind: item.kind,
        inputDigest: item.inputDigest,
        inputRevision: item.inputRevision,
        runInputRevision: item.runInputRevision,
        sources: item.sources.map(({ id, digest }) => ({ id, digest })),
        status: "mapped",
        reason: null,
        model: null,
        promptVersions: [],
        outputDigest: null,
        deterministicFailures: [],
        humanVerdict: null,
        latencyMs: null,
        cost: { certainty: "not_incurred", usd: 0 },
      })),
    };
    if (mode === "live") {
      const admission = liveConfig(opt, env);
      report.blockers = admission.blockers;
      if (admission.config) {
        const config = admission.config;
        report.pricingVersion = config.pricingVersion;
        report.maxCostCeilingUsd =
          Math.ceil(
            ((config.maxRequests *
              (config.maxInputTokens * config.inputUsdPerMillion +
                config.maxOutputTokens * config.outputUsdPerMillion)) /
              1000000) *
              1000000,
          ) / 1000000;
        const provider = deps.providerFactory
          ? deps.providerFactory(config)
          : await (
              await import("./opak-maintenance-live.js")
            ).createMaintenanceProvider(config);
        report.status = "completed";
        let knownCost = 0;
        for (let index = 0; index < cases.length; index++) {
          const item = cases[index]!,
            evidence = report.items[index]!;
          if (item.kind !== "text") {
            evidence.status = "blocked";
            evidence.reason =
              item.kind === "vision"
                ? "authorized_low_resolution_image_required"
                : "separate_service_worker_evidence_required";
            continue;
          }
          if (
            report.providerRequests >= config.maxRequests ||
            knownCost >= config.budgetUsd
          ) {
            report.stopReason =
              report.providerRequests >= config.maxRequests
                ? "request_cap"
                : "budget_exhausted";
            report.status = "stopped";
            break;
          }
          let attempt: EvaluationAttempt;
          try {
            attempt = await provider.evaluate(item);
          } catch {
            attempt = {
              providerRequests: 1,
              model: config.model,
              promptVersions: [],
              latencyMs: 0,
              costUsd: null,
              costCertainty: "unknown",
              failure: "provider_error",
            };
          }
          assert(
            Number.isSafeInteger(attempt.providerRequests) &&
              attempt.providerRequests >= 0 &&
              attempt.providerRequests <= config.maxRequests,
          );
          assert(
            safeVersion.test(attempt.model) &&
              attempt.promptVersions.every((version) =>
                safeVersion.test(version),
              ),
          );
          assert(Number.isFinite(attempt.latencyMs) && attempt.latencyMs >= 0);
          assert(
            attempt.costCertainty === "unknown"
              ? attempt.costUsd === null
              : typeof attempt.costUsd === "number" &&
                  Number.isFinite(attempt.costUsd) &&
                  attempt.costUsd >= 0,
          );
          report.providerRequests += attempt.providerRequests;
          if (attempt.providerRequests > 0)
            report.qualityStatus = "human_review_required";
          evidence.model = attempt.model;
          evidence.promptVersions = attempt.promptVersions;
          evidence.latencyMs = attempt.latencyMs;
          evidence.cost = {
            certainty: attempt.costCertainty,
            usd: attempt.costUsd,
          };
          evidence.reason = attempt.failure ?? null;
          evidence.status =
            attempt.candidate && !attempt.failure ? "candidate" : "failed";
          if (attempt.candidate) {
            evidence.deterministicFailures = checkMaintenanceCandidate(
              item,
              attempt.candidate,
            );
            evidence.outputDigest = digest(attempt.candidate);
            if (evidence.deterministicFailures.length)
              evidence.status = "failed";
          }
          if (opt["include-private-content"] === true)
            evidence.privateContent = {
              sources: item.sources.map(({ id, text }) => ({ id, text })),
              output: attempt.candidate ?? null,
            };
          if (attempt.costCertainty === "unknown" || attempt.costUsd === null) {
            report.stopReason = "unknown_cost";
            report.status = "stopped";
            break;
          }
          knownCost += attempt.costUsd;
          if (
            ["budget_exhausted", "request_cap", "input_bound"].includes(
              attempt.failure ?? "",
            )
          ) {
            report.stopReason = attempt.failure!;
            report.status = "stopped";
            break;
          }
        }
        for (const item of report.items)
          if (item.status === "mapped") {
            item.status = "blocked";
            item.reason = "run_stopped_before_case";
          }
      } else
        for (const item of report.items) {
          item.status = "blocked";
          item.reason = "live_admission_blocked";
        }
    }
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    await file.close();
  }
}
const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runOpakMaintenanceCli(process.argv.slice(2), process.env)
    .then((report) => {
      // No fixture paths, source text, output, credentials, model errors, or human identity in logs.
      process.stdout.write(
        `${JSON.stringify({ schema: report.schema, mode: report.mode, status: report.status, cases: report.items.length, providerRequests: report.providerRequests, qualityStatus: report.qualityStatus, stopReason: report.stopReason, blockers: report.blockers })}\n`,
      );
      if (report.status === "blocked" || report.status === "stopped")
        process.exitCode = 2;
    })
    .catch(() => {
      process.stderr.write(
        "Opak evaluation failed; no content logged. Check private output and fixture schema.\n",
      );
      process.exitCode = 1;
    });
}

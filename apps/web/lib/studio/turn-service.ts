import { z } from "zod";

import type {
  AIUsage,
  StudioCategoryProposeInput,
  StudioComposeInput,
  StudioModel,
  StudioProposeInput,
  StudioSkillPromptSummary,
} from "@wukong/ai";
import { createStudioModel } from "@wukong/ai";
import {
  getSkill,
  skillsForRole,
  STUDIO_PROMPT_VERSIONS,
  studioTurnReservation,
  type SkillDefinition,
  type StudioAiPolicy,
} from "@wukong/core";
import type {
  StudioBudgetReservation,
  StudioMessage,
  StudioRun,
  StudioRunEvent,
  StudioSettings,
  StudioThread,
} from "@wukong/db";

import { ApiError } from "../route-support";
import type { WorkspaceRole } from "../session-context";
import type { SessionContext } from "../session-context-port";
import type { StudioFlagSettings } from "../studio-flags";
import type {
  CreateThreadBody,
  CreateThreadResult,
  GetOutputResult,
  GetThreadResult,
  ListOutputsResult,
  ListThreadsResult,
  OutputActionResult,
  SendMessageBody,
  StudioInboxResult,
  StudioMessageResponse,
  StudioMetricsResult,
  StudioOverviewResult,
  StudioOutputSummary,
  StudioOutputVersionResponse,
  StudioRunEventResponse,
  StudioRunResponse,
  StudioSendResult,
  StudioThreadResponse,
  StudioOutputListQuery,
  StudioThreadListQuery,
} from "./contracts";
import { STUDIO_DEFAULT_THREAD_TITLE } from "./contracts";
import {
  STUDIO_METRICS_WINDOW_DAYS,
  STUDIO_PAGE_SIZE,
  studioOutputListQuerySchema,
  studioThreadListQuerySchema,
} from "./contracts";
import {
  composeDeterministicReply,
  composeNeedsInputReply,
} from "./compose-deterministic";
import { buildEvidencePack } from "./evidence";
import { buildStudioInbox } from "./inbox";
import {
  budgetAlertEvent,
  budgetAlertLevel,
  emitStudioEvent,
  turnMetricEvent,
} from "./observability";
import {
  createCopyProposalOutput,
  createFindingOutput,
  createReportOutput,
  type CopyProposalPayload,
} from "./output-service";
import {
  categoryMapProposalPayloadSchema,
  deterministicCategoryLimitations,
  sanitizeCategorySuggestions,
  type CategoryMapContext,
  type CategoryMapSuggestion,
} from "./category-map";
import {
  supplierIntelPayloadFromContext,
  supplierIntelProposalPayloadSchema,
  type SupplierIntelContext,
} from "./supplier-intel";
import { buildStudioReadDeps } from "./read-deps";
import { merchantAuditPayloadSchema } from "./report-payload";
import type { ListingCopySnapshot } from "./tools";
import {
  createStudioTurnLimits,
  StudioTurnDeadlineError,
  StudioTurnStepBudgetError,
  type StudioTurnLimits,
} from "./turn-limits";
import {
  requireStudioSession,
  studioNotFound,
  type StudioDatabase,
  type StudioSessionDeps,
} from "./session";
import {
  translatedLine,
  turnReplySchema,
  type EvidencePack,
  type ModelAnalysis,
  type StudioTraceStep,
  type StudioTurnReply,
  type TranslatedLine,
  type TranslatedValues,
} from "./types";

/**
 * The deterministic conversation turn service (plan Task 6 + Task 8 model
 * integration).
 *
 * One `sendMessage` runs the protocol from spec §3.2 in order: flags/session/
 * role, thread visibility, skill resolution, deterministic evidence pack,
 * deterministic reply, optional labelled model analysis under a reviewed
 * budget reservation, then a single persist step (assistant message, run
 * result, ordered trace events, audit). There is no streaming, no retry and no
 * write authority anywhere on this path.
 *
 * Everything is injected so tests run without Postgres, a provider or a real
 * clock.
 */

/** Persisted `created_by` for content the service itself produced. */
const STUDIO_MESSAGE_ACTOR = "studio";

/** Roles allowed to see a `private` thread regardless of its creator. */
const THREAD_ADMIN_ROLES: readonly WorkspaceRole[] = ["admin", "owner"];

const UUID = z.string().uuid();

export type StudioServiceDeps = StudioSessionDeps & {
  isStudioAiEnabled: (
    env: NodeJS.ProcessEnv,
    settings: StudioFlagSettings,
  ) => boolean;
  now?: () => Date;
  /** Monotonic clock for the hard turn deadlines (defaults to Date.now). */
  monotonicNow?: () => number;
  /**
   * Injected model factory. Returning `null` means "no live model configured"
   * (the turn stays deterministic). The default binding refuses to construct
   * one without the provider credential in the server environment.
   */
  createModel?: (settings: StudioSettings) => StudioModel | null;
};

type PreparedTurn =
  | {
      replayed: true;
      thread: StudioThread;
      skill: SkillDefinition;
      run: StudioRun;
    }
  | {
      replayed: false;
      thread: StudioThread;
      skill: SkillDefinition;
      run: StudioRun;
      operatorMessage: StudioMessage;
    };

function asIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function threadView(thread: StudioThread): StudioThreadResponse {
  return {
    threadId: thread.id,
    title: thread.title,
    skillKey: thread.skillKey,
    visibility: thread.visibility,
    status: thread.status,
    createdBy: thread.createdBy,
    lastMessageAt: asIso(thread.lastMessageAt),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

function messageView(message: StudioMessage): StudioMessageResponse {
  return {
    messageId: message.id,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    clientMessageId: message.clientMessageId,
    runId: message.runId,
    createdBy: message.createdBy,
    createdAt: message.createdAt.toISOString(),
  };
}

function eventView(event: StudioRunEvent): StudioRunEventResponse {
  return {
    eventId: event.id,
    sequence: event.sequence,
    kind: event.kind,
    toolId: event.toolId,
    state: event.state,
    payload: event.payload,
    durationMs: event.durationMs,
    createdAt: event.createdAt.toISOString(),
  };
}

function runView(
  run: StudioRun,
  events: StudioRunEvent[],
  reservation: StudioBudgetReservation | null,
): StudioRunResponse {
  return {
    runId: run.id,
    threadId: run.threadId,
    status: run.status,
    skillKey: run.skillKey,
    skillVersion: run.skillVersion,
    provider: run.provider,
    model: run.model,
    promptVersions: run.promptVersions,
    errorCode: run.errorCode,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    estimatedCostUsd: run.estimatedCostUsd,
    reservedUsd: reservation?.reservedUsd ?? run.reservedUsd,
    settledUsd: run.settledUsd,
    reservation: reservation
      ? {
          state: reservation.state,
          pricingVersion: reservation.pricingVersion,
          reservedUsd: reservation.reservedUsd,
          settledUsd: reservation.settledUsd,
        }
      : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: asIso(run.startedAt),
    finishedAt: asIso(run.finishedAt),
    events: events.map(eventView),
  };
}

/** Rebuild the render-facing trace from persisted run events. */
function traceFromEvent(event: StudioRunEvent): StudioTraceStep {
  const payload = event.payload;
  const detail: TranslatedLine =
    typeof payload.key === "string"
      ? {
          key: payload.key,
          values: (payload.values ?? {}) as TranslatedValues,
        }
      : translatedLine("studio.trace.unknown");
  return {
    kind: event.kind,
    toolId: event.toolId,
    state: event.state,
    durationMs: event.durationMs,
    detail,
  };
}

/** Persisted event shape for one render-facing trace step. */
function traceEventInput(step: StudioTraceStep): {
  kind: StudioTraceStep["kind"];
  state: StudioTraceStep["state"];
  toolId?: string | null;
  payload?: Record<string, unknown>;
  durationMs?: number | null;
} {
  return {
    kind: step.kind,
    state: step.state,
    toolId: step.toolId,
    payload: step.detail as unknown as Record<string, unknown>,
    durationMs: step.durationMs,
  };
}

function modelTrace(
  state: StudioTraceStep["state"],
  key: string,
  values: Record<string, string | number | boolean> = {},
): StudioTraceStep {
  return {
    kind: "model",
    toolId: null,
    state,
    durationMs: null,
    detail: translatedLine(key, values),
  };
}

/** Round up to the six decimal places the budget tables store. */
function formatUsd(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 99_999_999) return null;
  return (Math.ceil(value * 1_000_000) / 1_000_000).toFixed(6);
}

/** Content-free provider failure category for the trace, never the message. */
function modelFailureCategory(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (name === "ProviderApiError") return "provider_unavailable";
  if (name === "ProviderOutputError") return "invalid_output";
  if (name === "ProviderRefusalError") return "refused";
  return "model_error";
}

/** Only reviewed admission reasons may reach the trace/response. */
function budgetAdmissionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known = [
    "unverified_model_budget_bound",
    "run_ceiling_too_small",
    "budget_cap_too_small",
    "pricingVersion is required",
    "studio budget values must be decimal strings",
  ];
  return known.includes(message) ? message : "not_admitted";
}

/**
 * Deterministic keyword routing stands in for the planner when no model is
 * configured (spec §3.2 step 4): one skill, never a skill the caller names
 * outside the registry.
 */
export function routeSkillKey(text: string): string {
  // Traditional Chinese forms are written as escapes so the localisation
  // ratchet does not mistake routing keywords for untranslated UI copy.
  return /(gap|blocked|block|approv|export|\u7f3a\u53e3|\u963b\u64cb|\u6838\u51c6|\u5be9\u6838|\u532f\u51fa)/i.test(
    text,
  )
    ? "catalog.gap_review"
    : "catalog.find";
}

/** Parse a count into a non-negative safe integer, never NaN/Infinity. */
function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Keep an aggregate decimal string honest; anything malformed becomes "0". */
function decimalString(value: unknown): string {
  const candidate = String(value ?? "0").trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(candidate) ? candidate : "0";
}

function isThreadVisible(
  thread: StudioThread,
  actorId: string,
  role: WorkspaceRole,
): boolean {
  if (thread.visibility !== "private") return true;
  if (thread.createdBy === actorId) return true;
  return THREAD_ADMIN_ROLES.includes(role);
}

function assertThreadVisible(
  thread: StudioThread,
  actorId: string,
  role: WorkspaceRole,
): void {
  if (!isThreadVisible(thread, actorId, role)) throw studioNotFound();
}

function skillPromptSummary(skill: SkillDefinition): StudioSkillPromptSummary {
  return {
    key: skill.key,
    version: skill.version,
    title: { ...skill.title },
    outcome: { ...skill.outcome },
    limitation: { ...skill.limitation },
    inputNames: skill.inputs.map((field) => field.name),
    allowedTools: [...skill.allowedTools],
    requiredSources: [...skill.evidence.requiredSources],
  };
}

/** Bounded pack projection for the composer: refs, counts and tool states. */
function modelComposeInput(input: {
  skill: SkillDefinition;
  pack: EvidencePack;
  body: SendMessageBody;
}): StudioComposeInput {
  const coverage: Record<string, string> = {};
  for (const [kind, value] of input.pack.coverage) coverage[kind] = value;
  return {
    locale: input.body.locale,
    question: input.body.text.slice(0, 2000),
    skill: skillPromptSummary(input.skill),
    evidenceSummary: {
      coverage,
      sources: input.pack.sources.slice(0, 20).map((source) => ({
        ref: source.ref.slice(0, 200),
        kind: source.kind,
        label: source.label.slice(0, 120),
      })),
      checks: input.pack.checks.slice(0, 30).map((check) => ({
        key: check.key,
        state: check.state,
        values: check.values,
      })),
    },
    toolResults: input.pack.trace.slice(0, 6).map((step) => ({
      toolId: step.toolId,
      state: step.state,
      detail: step.detail.key,
    })),
  };
}

/**
 * Build a live model only when the workspace settings carry every reviewed
 * field and the provider credential exists in the server environment. Any
 * missing/blank value fails closed to `null` (deterministic turn only).
 */
function createDefaultModel(
  settings: StudioSettings,
  env: NodeJS.ProcessEnv,
): StudioModel | null {
  const ai = settings.ai;
  if (!ai) return null;
  const apiKey =
    ai.provider === "opencode-go"
      ? env.OPENCODE_GO_API_KEY
      : env.OPENROUTER_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  try {
    return createStudioModel({
      backend: ai.provider,
      apiKey,
      model: ai.model,
      maxOutputTokens: ai.maxOutputTokens,
      timeoutMs: 25_000,
      ...(ai.provider === "opencode-go"
        ? {
            sessionId: `studio-${settings.workspaceId
              .replace(/[^A-Za-z0-9_-]/g, "-")
              .slice(0, 120)}`,
          }
        : {}),
    });
  } catch {
    return null;
  }
}

export function createStudioService(deps: StudioServiceDeps) {
  const database = (): StudioDatabase => deps.getDatabase();
  const environment = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const clock = (): Date => deps.now?.() ?? new Date();
  const monotonicNow = (): number =>
    (deps.monotonicNow ?? (() => Date.now()))();

  /**
   * Emit workspace-budget utilisation after a turn. The cap
   * (`monthlyBudgetUsd`) is the committed-USD admission cap, so this is an
   * alert on how close the workspace is to that cap, not a calendar reset.
   * Observability must never change a turn's outcome.
   */
  async function emitBudgetAlert(
    workspaceId: string,
    settings: StudioSettings,
  ): Promise<void> {
    const budgetUsd = settings.monthlyBudgetUsd;
    if (!budgetUsd) return;
    try {
      const committedUsd = await database().forWorkspace(workspaceId, (repos) =>
        repos.studio.budget.committedUsd(),
      );
      const level = budgetAlertLevel(committedUsd, budgetUsd);
      if (level)
        emitStudioEvent(budgetAlertEvent({ committedUsd, budgetUsd, level }));
    } catch {
      // Observability is best effort; the turn result already stands.
    }
  }

  /** Replay a client message id that already produced a run: never re-run it. */
  async function replayTurn(
    workspaceId: string,
    threadId: string,
    run: StudioRun,
  ): Promise<StudioSendResult> {
    if (run.status === "succeeded") {
      const persisted = await database().forWorkspace(
        workspaceId,
        async (repos) => {
          const messages = await repos.studio.messages.list(threadId, {
            limit: 200,
          });
          const assistant = messages.find(
            (message) =>
              message.role === "assistant" && message.runId === run.id,
          );
          const events = await repos.studio.runEvents.list(run.id);
          return { assistant, events };
        },
      );
      const parsed = persisted.assistant
        ? turnReplySchema.safeParse(persisted.assistant.content)
        : null;
      if (!persisted.assistant || !parsed?.success) {
        throw new ApiError(
          409,
          "run_incomplete",
          "The previous reply is not available.",
        );
      }
      return {
        threadId,
        messageId: persisted.assistant.id,
        runId: run.id,
        reply: parsed.data,
        trace: persisted.events.map(traceFromEvent),
        replayed: true,
      };
    }
    if (run.status === "queued" || run.status === "running") {
      throw new ApiError(
        409,
        "run_in_progress",
        "This message is still being processed.",
      );
    }
    if (run.status === "outcome_unknown") {
      throw new ApiError(
        409,
        "run_outcome_unknown",
        "The previous attempt has an unknown outcome; nothing is retried automatically.",
      );
    }
    throw new ApiError(
      409,
      "run_failed",
      "The previous attempt failed. Send a new message to retry.",
    );
  }

  /**
   * Optional model analysis. Admission is fail-closed at every branch and a
   * provider failure only degrades the turn: the deterministic records answer
   * is already composed and persisted either way.
   */
  async function analyseTurn(input: {
    workspaceId: string;
    settings: StudioSettings;
    run: StudioRun;
    skill: SkillDefinition;
    pack: EvidencePack;
    body: SendMessageBody;
    limits: StudioTurnLimits;
  }): Promise<{
    analysis: ModelAnalysis | null;
    usage: AIUsage | null;
    trace: StudioTraceStep | null;
    settledUsd: string | null;
  }> {
    const none = {
      analysis: null,
      usage: null,
      trace: null,
      settledUsd: null,
    } as const;
    const { settings } = input;
    const ai = settings.ai;
    if (!ai) return none;
    if (!deps.isStudioAiEnabled(environment(), settings)) return none;
    const monthlyBudgetUsd = settings.monthlyBudgetUsd;
    if (!monthlyBudgetUsd) return none;

    let reservedUsd: string;
    try {
      const policy: StudioAiPolicy = {
        provider: ai.provider,
        model: ai.model,
        pricingVersion: ai.pricingVersion,
        runCeilingUsd: settings.runCeilingUsd ?? "",
        budgetCapUsd: monthlyBudgetUsd,
        maxInputTokens: ai.maxInputTokens,
        inputUsdPerMillion: Number(ai.inputUsdPerMillion),
        outputUsdPerMillion: Number(ai.outputUsdPerMillion),
        maxOutputTokens: ai.maxOutputTokens,
      };
      reservedUsd = studioTurnReservation(policy);
    } catch (error) {
      return {
        ...none,
        trace: modelTrace("blocked", "studio.trace.model.not_admitted", {
          reason: budgetAdmissionReason(error),
        }),
      };
    }

    let model: StudioModel | null;
    try {
      model = deps.createModel
        ? deps.createModel(settings)
        : createDefaultModel(settings, environment());
    } catch {
      model = null;
    }
    if (!model) return none;

    const reservation = await database().forWorkspace(
      input.workspaceId,
      (repos) =>
        repos.studio.budget.reserve({
          runId: input.run.id,
          pricingVersion: ai.pricingVersion,
          reservedUsd,
          workspaceCapUsd: monthlyBudgetUsd,
        }),
    );
    if (!reservation.accepted) {
      return {
        ...none,
        trace: modelTrace("blocked", "studio.trace.model.budget_blocked"),
      };
    }

    try {
      input.limits.beginModel();
      const { analysis: raw, usage } = await model.compose(
        modelComposeInput({
          skill: input.skill,
          pack: input.pack,
          body: input.body,
        }),
      );
      // Citation grounding: a claim survives only when every ref it cites is a
      // source this turn actually resolved from workspace records.
      const resolvedRefs = new Set(
        input.pack.sources.map((source) => source.ref),
      );
      const claims = raw.claims.filter((claim) =>
        claim.evidenceRefs.every((ref) => resolvedRefs.has(ref)),
      );
      const droppedClaims = raw.claims.length - claims.length;
      const analysis: ModelAnalysis = {
        sections: raw.sections.map((section) => ({
          heading: section.heading.slice(0, 200),
          body: section.body.slice(0, 4000),
        })),
        claims: claims.map((claim) => ({
          text: claim.text.slice(0, 2000),
          evidenceRefs: claim.evidenceRefs.map((ref) => ref.slice(0, 200)),
        })),
        limitations: raw.limitations.map((line) => line.slice(0, 500)),
        followUps: raw.followUps.map((line) => line.slice(0, 200)),
        configured: true,
        droppedClaims,
      };
      const settledUsd = formatUsd(usage.estimatedCostUsd);
      if (settledUsd) {
        const settled = await database().forWorkspace(
          input.workspaceId,
          (repos) => repos.studio.budget.settle(input.run.id, settledUsd),
        );
        if (!settled) {
          await database().forWorkspace(input.workspaceId, (repos) =>
            repos.studio.budget.markUncertain(input.run.id),
          );
        }
      } else {
        // Unknown cost keeps the hold: never claim it was released or exact.
        await database().forWorkspace(input.workspaceId, (repos) =>
          repos.studio.budget.markUncertain(input.run.id),
        );
      }
      return {
        analysis,
        usage,
        trace: modelTrace("done", "studio.trace.model.done", {
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          droppedClaims,
        }),
        settledUsd,
      };
    } catch (error) {
      try {
        await database().forWorkspace(input.workspaceId, (repos) =>
          repos.studio.budget.markUncertain(input.run.id),
        );
      } catch {
        // The hold stays uncertain by omission; the turn still degrades to the
        // deterministic answer rather than failing over accounting.
      }
      return {
        analysis: {
          sections: [],
          claims: [],
          limitations: [],
          followUps: [],
          configured: false,
          droppedClaims: 0,
        },
        usage: null,
        trace: modelTrace("failed", "studio.trace.model.failed", {
          category: modelFailureCategory(error),
        }),
        settledUsd: null,
      };
    }
  }

  const LISTING_ID_PATTERN =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  /** The first listing UUID mentioned in the message, if any. */
  function parseListingId(text: string): string | null {
    return LISTING_ID_PATTERN.exec(text)?.[0] ?? null;
  }

  const COPY_FIELD_VALUE: Record<
    string,
    (copy: ListingCopySnapshot) => string
  > = {
    "title.en": (copy) => copy.title.en,
    "title.zh-Hant": (copy) => copy.title["zh-Hant"],
    "description.en": (copy) => copy.description.en,
    "description.zh-Hant": (copy) => copy.description["zh-Hant"],
    "seo.title.en": (copy) => copy.seo.title.en,
    "seo.title.zh-Hant": (copy) => copy.seo.title["zh-Hant"],
    "seo.description.en": (copy) => copy.seo.description.en,
    "seo.description.zh-Hant": (copy) => copy.seo.description["zh-Hant"],
  };

  type CopyProposalContext = {
    listingId: string;
    activeVersionId: string;
    activeVersionSequence: number;
    currentCopy: ListingCopySnapshot;
    allowedFields: string[];
  };

  type CopyProposalOutcome = {
    output: { outputId: string; revision: number } | null;
    fieldCount: number;
    droppedCount: number;
    usage: AIUsage | null;
    settledUsd: string | null;
    trace: StudioTraceStep | null;
    limitations: TranslatedLine[];
  };

  /**
   * Optional copy-proposal model call (plan Task 9).
   *
   * Admission mirrors the analysis path: fail-closed flags/settings/budget, one
   * reviewed reservation, no retry. Only fields whose refs resolve to this
   * turn's evidence and whose names are in the reviewed field list survive; the
   * artifact is versioned and read back before the reply claims success.
   */
  async function proposeCopyTurn(input: {
    session: SessionContext;
    settings: StudioSettings;
    workspaceId: string;
    threadId: string;
    run: StudioRun;
    skill: SkillDefinition;
    pack: EvidencePack;
    body: SendMessageBody;
    now: Date;
    limits: StudioTurnLimits;
  }): Promise<CopyProposalOutcome> {
    const none: CopyProposalOutcome = {
      output: null,
      fieldCount: 0,
      droppedCount: 0,
      usage: null,
      settledUsd: null,
      trace: null,
      limitations: [translatedLine("studio.limit.copy_model_required")],
    };
    const ai = input.settings.ai;
    if (!ai) return none;
    if (!deps.isStudioAiEnabled(environment(), input.settings)) return none;
    const monthlyBudgetUsd = input.settings.monthlyBudgetUsd;
    if (!monthlyBudgetUsd) return none;

    let reservedUsd: string;
    try {
      const policy: StudioAiPolicy = {
        provider: ai.provider,
        model: ai.model,
        pricingVersion: ai.pricingVersion,
        runCeilingUsd: input.settings.runCeilingUsd ?? "",
        budgetCapUsd: monthlyBudgetUsd,
        maxInputTokens: ai.maxInputTokens,
        inputUsdPerMillion: Number(ai.inputUsdPerMillion),
        outputUsdPerMillion: Number(ai.outputUsdPerMillion),
        maxOutputTokens: ai.maxOutputTokens,
      };
      reservedUsd = studioTurnReservation(policy);
    } catch (error) {
      return {
        ...none,
        trace: modelTrace("blocked", "studio.trace.model.not_admitted", {
          reason: budgetAdmissionReason(error),
        }),
      };
    }

    let model: StudioModel | null;
    try {
      model = deps.createModel
        ? deps.createModel(input.settings)
        : createDefaultModel(input.settings, environment());
    } catch {
      model = null;
    }
    if (!model) return none;

    const reservation = await database().forWorkspace(
      input.workspaceId,
      (repos) =>
        repos.studio.budget.reserve({
          runId: input.run.id,
          pricingVersion: ai.pricingVersion,
          reservedUsd,
          workspaceCapUsd: monthlyBudgetUsd,
        }),
    );
    if (!reservation.accepted) {
      return {
        ...none,
        trace: modelTrace("blocked", "studio.trace.model.budget_blocked"),
      };
    }

    try {
      const context = input.pack.context.copyProposal as
        CopyProposalContext | undefined;
      if (!context) throw new Error("studio_proposal_context_missing");
      const gaps = input.pack.checks
        .filter((check) => check.key === "studio.check.copy_gap")
        .map((check) => ({
          code: String(check.values.code ?? ""),
          blocking: check.values.blocking === true,
        }));
      const evidenceRefs = input.pack.sources.map((source) => source.ref);
      const proposeInput: StudioProposeInput = {
        locale: input.body.locale,
        question: input.body.text,
        skill: skillPromptSummary(input.skill),
        listing: context.currentCopy,
        gaps,
        allowedFields:
          context.allowedFields as StudioProposeInput["allowedFields"],
        evidenceRefs,
      };
      input.limits.beginModel();
      const { proposal, usage } = await model.propose(proposeInput);
      const resolved = new Set(evidenceRefs);
      const allowed = new Set(context.allowedFields);
      const fields = proposal.fields
        .filter(
          (field) =>
            allowed.has(field.field) &&
            field.evidenceRefs.every((ref) => resolved.has(ref)),
        )
        .map((field) => ({
          field: field.field,
          current: COPY_FIELD_VALUE[field.field]
            ? COPY_FIELD_VALUE[field.field]!(context.currentCopy)
            : null,
          proposed: field.proposed,
          evidenceRefs: field.evidenceRefs,
        }));
      const droppedCount = proposal.fields.length - fields.length;
      const settledUsd = formatUsd(usage.estimatedCostUsd);
      if (settledUsd) {
        const settled = await database().forWorkspace(
          input.workspaceId,
          (repos) => repos.studio.budget.settle(input.run.id, settledUsd),
        );
        if (!settled)
          await database().forWorkspace(input.workspaceId, (repos) =>
            repos.studio.budget.markUncertain(input.run.id),
          );
      } else {
        await database().forWorkspace(input.workspaceId, (repos) =>
          repos.studio.budget.markUncertain(input.run.id),
        );
      }
      const trace = modelTrace("done", "studio.trace.model.done", {
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        droppedClaims: droppedCount,
      });
      if (fields.length === 0)
        return {
          output: null,
          fieldCount: 0,
          droppedCount,
          usage,
          settledUsd,
          trace,
          limitations: [
            translatedLine("studio.limit.copy_fields_dropped", {
              count: droppedCount,
            }),
          ],
        };
      const payload: CopyProposalPayload = {
        listingId: context.listingId,
        activeVersionId: context.activeVersionId,
        activeVersionSequence: context.activeVersionSequence,
        fields,
        limitations: proposal.limitations.slice(0, 10),
        asOf: input.now.toISOString(),
      };
      const created = await createCopyProposalOutput(
        { getDatabase: () => deps.getDatabase() },
        {
          workspaceId: input.workspaceId,
          actorId: input.session.actorId,
          threadId: input.threadId,
          runId: input.run.id,
          title: `Copy proposal · ${context.currentCopy.title.en || context.currentCopy.title["zh-Hant"]}`,
          payload,
          asOf: input.now,
        },
      );
      return {
        output: { outputId: created.outputId, revision: created.revision },
        fieldCount: fields.length,
        droppedCount,
        usage,
        settledUsd,
        trace,
        limitations:
          droppedCount > 0
            ? [
                translatedLine("studio.limit.copy_fields_dropped", {
                  count: droppedCount,
                }),
              ]
            : [],
      };
    } catch (error) {
      try {
        await database().forWorkspace(input.workspaceId, (repos) =>
          repos.studio.budget.markUncertain(input.run.id),
        );
      } catch {
        // The hold stays uncertain by omission; the deterministic answer stands.
      }
      return {
        ...none,
        limitations: [translatedLine("studio.limit.copy_model_required")],
        trace: modelTrace("failed", "studio.trace.model.failed", {
          category: modelFailureCategory(error),
        }),
      };
    }
  }

  /**
   * Optional, budgeted category suggestions (C1).
   *
   * The deterministic artifact exists without this. When a reviewed model is
   * configured, admitted under the same per-turn reservation as the copy
   * proposer, and implements the typed `proposeCategory` capability, its
   * suggestions are grounded against the pack refs, de-duplicated and counted;
   * anything ungrounded is dropped before the artifact is written.
   */
  async function proposeCategoryTurn(input: {
    session: SessionContext;
    settings: StudioSettings;
    workspaceId: string;
    run: StudioRun;
    skill: SkillDefinition;
    context: CategoryMapContext;
    body: SendMessageBody;
    limits: StudioTurnLimits;
  }): Promise<{
    suggestions: CategoryMapSuggestion[];
    droppedCount: number;
    usage: AIUsage | null;
    settledUsd: string | null;
    trace: StudioTraceStep | null;
    limitations: TranslatedLine[];
  }> {
    const none = {
      suggestions: [] as CategoryMapSuggestion[],
      droppedCount: 0,
      usage: null,
      settledUsd: null,
      trace: null as StudioTraceStep | null,
      limitations: [translatedLine("studio.limit.category_model_unavailable")],
    };
    const ai = input.settings.ai;
    if (!ai) return none;
    if (!deps.isStudioAiEnabled(environment(), input.settings)) return none;
    const monthlyBudgetUsd = input.settings.monthlyBudgetUsd;
    if (!monthlyBudgetUsd) return none;

    let reservedUsd: string;
    try {
      const policy: StudioAiPolicy = {
        provider: ai.provider,
        model: ai.model,
        pricingVersion: ai.pricingVersion,
        runCeilingUsd: input.settings.runCeilingUsd ?? "",
        budgetCapUsd: monthlyBudgetUsd,
        maxInputTokens: ai.maxInputTokens,
        inputUsdPerMillion: Number(ai.inputUsdPerMillion),
        outputUsdPerMillion: Number(ai.outputUsdPerMillion),
        maxOutputTokens: ai.maxOutputTokens,
      };
      reservedUsd = studioTurnReservation(policy);
    } catch (error) {
      return {
        ...none,
        trace: modelTrace("blocked", "studio.trace.model.not_admitted", {
          reason: budgetAdmissionReason(error),
        }),
      };
    }

    let model: StudioModel | null;
    try {
      model = deps.createModel
        ? deps.createModel(input.settings)
        : createDefaultModel(input.settings, environment());
    } catch {
      model = null;
    }
    if (!model || typeof model.proposeCategory !== "function") return none;

    const reservation = await database().forWorkspace(
      input.workspaceId,
      (repos) =>
        repos.studio.budget.reserve({
          runId: input.run.id,
          pricingVersion: ai.pricingVersion,
          reservedUsd,
          workspaceCapUsd: monthlyBudgetUsd,
        }),
    );
    if (!reservation.accepted) {
      return {
        ...none,
        trace: modelTrace("blocked", "studio.trace.model.budget_blocked"),
      };
    }

    try {
      const proposeInput: StudioCategoryProposeInput = {
        locale: input.body.locale,
        question: input.body.text,
        skill: skillPromptSummary(input.skill),
        listing: {
          listingId: input.context.listingId,
          title: input.context.listingTitle,
          currentCategory: input.context.currentCategory,
        },
        catalogEvidence: input.context.catalogEvidence,
        allowedEvidenceRefs: input.context.allowedEvidenceRefs,
      };
      input.limits.beginModel();
      const { proposal, usage } = await model.proposeCategory(proposeInput);
      const sanitized = sanitizeCategorySuggestions({
        proposed: proposal.suggestions,
        allowedEvidenceRefs: input.context.allowedEvidenceRefs,
        currentCategory: input.context.currentCategory,
      });
      const settledUsd = formatUsd(usage.estimatedCostUsd);
      if (settledUsd) {
        const settled = await database().forWorkspace(
          input.workspaceId,
          (repos) => repos.studio.budget.settle(input.run.id, settledUsd),
        );
        if (!settled)
          await database().forWorkspace(input.workspaceId, (repos) =>
            repos.studio.budget.markUncertain(input.run.id),
          );
      } else {
        await database().forWorkspace(input.workspaceId, (repos) =>
          repos.studio.budget.markUncertain(input.run.id),
        );
      }
      const trace = modelTrace("done", "studio.trace.model.done", {
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        droppedClaims: sanitized.droppedCount,
      });
      return {
        suggestions: sanitized.suggestions,
        droppedCount: sanitized.droppedCount,
        usage,
        settledUsd,
        trace,
        limitations:
          sanitized.droppedCount > 0
            ? [
                translatedLine("studio.limit.category_suggestions_dropped", {
                  count: sanitized.droppedCount,
                }),
              ]
            : [],
      };
    } catch (error) {
      try {
        await database().forWorkspace(input.workspaceId, (repos) =>
          repos.studio.budget.markUncertain(input.run.id),
        );
      } catch {
        // The hold stays uncertain by omission; the deterministic answer stands.
      }
      return {
        ...none,
        trace: modelTrace("failed", "studio.trace.model.failed", {
          category: modelFailureCategory(error),
        }),
      };
    }
  }

  /** Persist and return one completed deterministic (+ optional model) turn. */
  async function completeTurn(input: {
    session: SessionContext;
    settings: StudioSettings;
    workspaceId: string;
    threadId: string;
    run: StudioRun;
    skill: SkillDefinition;
    body: SendMessageBody;
    now: Date;
    limits: StudioTurnLimits;
    startedAt: number;
    recordUsage: (usage: AIUsage, settledUsd: string | null) => void;
  }): Promise<StudioSendResult> {
    const packResult = await database().forWorkspace(
      input.workspaceId,
      (repos) =>
        buildEvidencePack({
          skill: input.skill,
          deps: buildStudioReadDeps(repos),
          role: input.session.role,
          now: input.now,
          limits: input.limits,
          query: (() => {
            // The audit report parses its period from the operator's text, so
            // it receives the turn text even though it declares no `query`
            // input; every other skill only gets it when it declares one.
            if (
              input.skill.key === "merchant.audit" ||
              input.skill.inputs.some((field) => field.name === "query")
            )
              return input.body.text;
            return null;
          })(),
          listingId: input.skill.inputs.some(
            (field) => field.name === "listingId",
          )
            ? parseListingId(input.body.text)
            : null,
          ...(input.body.attachmentAssetIds &&
          input.body.attachmentAssetIds.length > 0
            ? { attachmentAssetIds: input.body.attachmentAssetIds }
            : {}),
        }),
    );

    let reply: StudioTurnReply;
    let trace: StudioTraceStep[];
    let analysis: ModelAnalysis | null = null;
    let usage: AIUsage | null = null;
    let settledUsd: string | null = null;

    if (packResult.status === "needs_input") {
      reply = composeNeedsInputReply(packResult);
      trace = [
        {
          kind: "notice",
          toolId: null,
          state: "info",
          durationMs: null,
          detail: translatedLine("studio.trace.needs_input"),
        },
      ];
    } else {
      const deterministic = composeDeterministicReply({
        skill: input.skill,
        pack: packResult.pack,
      });
      trace = [...packResult.pack.trace];
      if (input.skill.key === "listing.copy_proposal") {
        const proposal = await proposeCopyTurn({
          session: input.session,
          settings: input.settings,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          run: input.run,
          skill: input.skill,
          pack: packResult.pack,
          limits: input.limits,
          body: input.body,
          now: input.now,
        });
        usage = proposal.usage;
        settledUsd = proposal.settledUsd;
        if (proposal.trace) trace.push(proposal.trace);
        const sections = [...deterministic.records.sections];
        if (proposal.output)
          sections.push(
            translatedLine("studio.answer.copy_proposal", {
              fields: proposal.fieldCount,
              dropped: proposal.droppedCount,
            }),
          );
        reply = turnReplySchema.parse({
          ...deterministic,
          status: proposal.output ? "answered" : "partial",
          records: { ...deterministic.records, sections },
          outputs: proposal.output ? [proposal.output] : [],
          limitations: [...deterministic.limitations, ...proposal.limitations],
        });
      } else if (input.skill.key === "listing.draft_from_sources") {
        // Dispatch preparation is deterministic on purpose: the turn validates
        // the operator's source assets and records what a confirmed dispatch
        // would send. It never creates the listing; only the explicit dispatch
        // route does that (plan Task 10).
        reply = turnReplySchema.parse({ ...deterministic });
      } else if (input.skill.key === "merchant.audit") {
        // The audit report is composed deterministically and persisted as a
        // versioned artifact with a readback before the reply claims it exists
        // (plan Task 11). No model is involved.
        const auditPayload = merchantAuditPayloadSchema.safeParse(
          packResult.pack.context.merchantAudit,
        );
        if (!auditPayload.success) {
          reply = turnReplySchema.parse({
            ...deterministic,
            status: "partial",
          });
        } else {
          const created = await createReportOutput(
            { getDatabase: () => deps.getDatabase() },
            {
              workspaceId: input.workspaceId,
              actorId: input.session.actorId,
              threadId: input.threadId,
              runId: input.run.id,
              kind: "merchant_audit",
              title: `Merchant audit · ${input.now.toISOString()}`.slice(
                0,
                200,
              ),
              payload: auditPayload.data as unknown as Record<string, unknown>,
              asOf: input.now,
            },
          );
          reply = turnReplySchema.parse({
            ...deterministic,
            status: "answered",
            outputs: [
              { outputId: created.outputId, revision: created.revision },
            ],
          });
        }
      } else if (input.skill.key === "category.map_proposal") {
        // The deterministic slice always persists a read-only finding artifact;
        // with a configured, admitted model its grounded suggestions are added
        // (and ungrounded ones dropped) before the same artifact is written.
        const context = packResult.pack.context.categoryMap as
          CategoryMapContext | undefined;
        if (!context) {
          reply = turnReplySchema.parse({
            ...deterministic,
            status: "partial",
          });
        } else {
          const proposal = await proposeCategoryTurn({
            session: input.session,
            settings: input.settings,
            workspaceId: input.workspaceId,
            run: input.run,
            skill: input.skill,
            context,
            body: input.body,
            limits: input.limits,
          });
          usage = proposal.usage;
          settledUsd = proposal.settledUsd;
          if (proposal.trace) trace.push(proposal.trace);
          const limitations = [
            ...deterministicCategoryLimitations({
              catalogUnavailable:
                packResult.pack.coverage.get("catalog") !== "present",
              listingUnavailable:
                packResult.pack.coverage.get("listing") !== "present",
              currentCategory: context.currentCategory,
            }),
            ...proposal.limitations,
          ].slice(0, 10);
          const payload = categoryMapProposalPayloadSchema.parse({
            schemaVersion: "wukong-category-map/v1",
            listingId: context.listingId,
            listingTitle: context.listingTitle,
            currentCategory: context.currentCategory,
            suggestions: proposal.suggestions,
            limitations,
            asOf: input.now.toISOString(),
          });
          const created = await createFindingOutput(
            { getDatabase: () => deps.getDatabase() },
            {
              workspaceId: input.workspaceId,
              actorId: input.session.actorId,
              threadId: input.threadId,
              runId: input.run.id,
              title: `Category map proposal · ${
                context.listingTitle || context.listingId
              }`.slice(0, 200),
              payload: payload as unknown as Record<string, unknown>,
              asOf: input.now,
              scope: { listingId: context.listingId },
            },
          );
          const sections = [...deterministic.records.sections];
          sections.push(
            translatedLine("studio.answer.category_map_suggestions", {
              suggestions: proposal.suggestions.length,
              dropped: proposal.droppedCount,
            }),
          );
          reply = turnReplySchema.parse({
            ...deterministic,
            status: proposal.suggestions.length > 0 ? "answered" : "partial",
            records: { ...deterministic.records, sections },
            outputs: [
              { outputId: created.outputId, revision: created.revision },
            ],
            limitations: [...deterministic.limitations, ...limitations],
          });
        }
      } else if (input.skill.key === "product_shot.prepare") {
        // Deterministic prepare/handoff only: the gated product-shot screen
        // (and its provider) remains the only place an image is processed.
        reply = turnReplySchema.parse({ ...deterministic });
      } else if (input.skill.key === "supplier.intel_proposal") {
        // Deterministic finding from the linked workbook row: the artifact
        // quotes stored cells and is saved as evidence; nothing is applied and
        // no model call is made.
        const context = packResult.pack.context.supplierIntel as
          SupplierIntelContext | undefined;
        const payload = context
          ? supplierIntelPayloadFromContext(context, input.now)
          : null;
        if (!context || !payload) {
          reply = turnReplySchema.parse({
            ...deterministic,
            status: "partial",
          });
        } else {
          const parsed = supplierIntelProposalPayloadSchema.parse(payload);
          const created = await createFindingOutput(
            { getDatabase: () => deps.getDatabase() },
            {
              workspaceId: input.workspaceId,
              actorId: input.session.actorId,
              threadId: input.threadId,
              runId: input.run.id,
              title: `Supplier intel · ${
                context.listingTitle || context.listingId
              }`.slice(0, 200),
              payload: parsed as unknown as Record<string, unknown>,
              asOf: input.now,
              scope: { listingId: context.listingId },
            },
          );
          reply = turnReplySchema.parse({
            ...deterministic,
            status: parsed.fields.length > 0 ? "answered" : "partial",
            outputs: [
              { outputId: created.outputId, revision: created.revision },
            ],
          });
        }
      } else {
        const modelOutcome = await analyseTurn({
          workspaceId: input.workspaceId,
          settings: input.settings,
          run: input.run,
          skill: input.skill,
          pack: packResult.pack,
          limits: input.limits,
          body: input.body,
        });
        analysis = modelOutcome.analysis;
        usage = modelOutcome.usage;
        settledUsd = modelOutcome.settledUsd;
        if (modelOutcome.trace) trace.push(modelOutcome.trace);
        reply = turnReplySchema.parse({ ...deterministic, analysis });
      }
    }

    // Preserve known usage if the subsequent message/audit transaction fails.
    if (usage) input.recordUsage(usage, settledUsd);
    const assistant = await database().forWorkspace(
      input.workspaceId,
      async (repos) => {
        if (trace.length > 0) {
          await repos.studio.runEvents.appendMany(
            input.run.id,
            trace.map(traceEventInput),
          );
        }
        const appendedMessage = await repos.studio.messages.append({
          threadId: input.threadId,
          role: "assistant",
          content: reply as unknown as Record<string, unknown>,
          runId: input.run.id,
          createdBy: STUDIO_MESSAGE_ACTOR,
        });
        await repos.studio.runs.complete(input.run.id, {
          ...(usage
            ? {
                provider: input.settings.ai?.provider ?? null,
                model: usage.model,
              }
            : {}),
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          estimatedCostUsd: usage ? formatUsd(usage.estimatedCostUsd) : null,
          settledUsd,
        });
        await repos.audit.write({
          workspaceId: input.workspaceId,
          actorId: input.session.actorId,
          entityId: input.run.id,
          action: "studio.run.completed",
          metadata: {
            threadId: input.threadId,
            runId: input.run.id,
            messageId: appendedMessage.message.id,
            replyStatus: reply.status,
            stepCount: trace.length,
            modelUsed: usage !== null,
            droppedClaims: analysis?.droppedClaims ?? 0,
          },
        });
        return appendedMessage.message;
      },
    );

    emitStudioEvent(
      turnMetricEvent({
        status: reply.status,
        durationMs: monotonicNow() - input.startedAt,
        toolSteps: input.limits.toolSteps,
        detailReads: input.limits.detailReads,
        modelCalls: input.limits.modelCalls,
        traceSteps: trace.length,
        outputCount: reply.outputs.length,
        limitationCount: reply.limitations.length,
        settledUsd,
      }),
    );
    await emitBudgetAlert(input.workspaceId, input.settings);

    return {
      threadId: input.threadId,
      messageId: assistant.id,
      runId: input.run.id,
      reply,
      trace,
      replayed: false,
    };
  }

  return {
    async createThread(body: CreateThreadBody): Promise<CreateThreadResult> {
      const { session } = await requireStudioSession(deps, "operator");
      let skillKey: string | null = null;
      if (body.skillKey) {
        const skill = getSkill(body.skillKey);
        if (!skill) throw new ApiError(400, "unknown_skill", "Unknown skill.");
        skillKey = skill.key;
      }
      const title = (body.title?.trim() || STUDIO_DEFAULT_THREAD_TITLE).slice(
        0,
        200,
      );
      const threadId = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const thread = await repos.studio.threads.create({
            createdBy: session.actorId,
            title,
            skillKey,
          });
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: thread.id,
            action: "studio.thread.created",
            metadata: { threadId: thread.id, skillKey },
          });
          return thread.id;
        },
      );
      return { threadId };
    },

    async listThreads(
      filters: StudioThreadListQuery = {},
    ): Promise<ListThreadsResult> {
      const { session, role } = await requireStudioSession(deps, "viewer");
      const parsed = studioThreadListQuerySchema.safeParse(filters);
      if (!parsed.success)
        throw new ApiError(400, "invalid_query", "Invalid query parameters.");
      const search = parsed.data.q?.trim();
      const offset = parsed.data.offset;
      const listed = await database().forWorkspace(
        session.workspaceId,
        (repos) =>
          repos.studio.threads.list({
            limit: STUDIO_PAGE_SIZE,
            offset,
            viewerId: session.actorId,
            includePrivate: THREAD_ADMIN_ROLES.includes(role),
            ...(search ? { q: search } : {}),
          }),
      );
      return {
        items: listed.items.map(threadView),
        truncated: listed.truncated,
        offset,
      };
    },

    async getThread(threadId: string): Promise<GetThreadResult> {
      const { session, role } = await requireStudioSession(deps, "viewer");
      if (!UUID.safeParse(threadId).success) throw studioNotFound();
      const bundle = await database().forWorkspace(
        session.workspaceId,
        (repos) =>
          repos.studio.threads.getWithMessages(threadId, {
            messageLimit: 100,
          }),
      );
      if (!bundle) throw studioNotFound();
      assertThreadVisible(bundle.thread, session.actorId, role);
      return {
        thread: threadView(bundle.thread),
        messages: bundle.messages.map(messageView),
      };
    },

    async sendMessage(
      threadId: string,
      body: SendMessageBody,
    ): Promise<StudioSendResult> {
      const { session, settings, role } = await requireStudioSession(
        deps,
        "operator",
      );
      if (!UUID.safeParse(threadId).success) throw studioNotFound();
      const workspaceId = session.workspaceId;
      const now = clock();
      const startedAt = monotonicNow();
      // Hard per-turn budgets (plan Task 14): 45 s wall clock, six first-class
      // tool steps, a bounded per-listing detail fan-out and at most two model
      // calls. Exceeding one is persisted as a failed run with a distinct code.
      const limits = createStudioTurnLimits({
        now: deps.monotonicNow ?? (() => Date.now()),
      });

      const prepared: PreparedTurn = await database().forWorkspace(
        workspaceId,
        async (repos) => {
          const bundle = await repos.studio.threads.getWithMessages(threadId, {
            messageLimit: 200,
          });
          if (!bundle) throw studioNotFound();
          assertThreadVisible(bundle.thread, session.actorId, role);

          const requestedKey = body.skillKey ?? bundle.thread.skillKey;
          const skill = requestedKey
            ? getSkill(requestedKey)
            : getSkill(routeSkillKey(body.text));
          if (!skill)
            throw new ApiError(400, "unknown_skill", "Unknown skill.");
          if (skill.status !== "pilot")
            throw new ApiError(
              400,
              "skill_unavailable",
              "This skill is not available.",
            );
          if (
            settings.allowedSkills.length > 0 &&
            !settings.allowedSkills.includes(skill.key)
          )
            throw new ApiError(
              403,
              "skill_not_allowed",
              "This skill is not enabled for the workspace.",
            );
          if (!skillsForRole(role).some((entry) => entry.key === skill.key))
            throw new ApiError(403, "insufficient_role", "Insufficient role.");

          const content: Record<string, unknown> = {
            text: body.text,
            locale: body.locale,
            ...(body.skillKey ? { skillKey: body.skillKey } : {}),
            ...(body.attachmentAssetIds && body.attachmentAssetIds.length > 0
              ? { attachmentAssetIds: body.attachmentAssetIds }
              : {}),
          };
          const appended = await repos.studio.messages.append({
            threadId,
            role: "operator",
            content,
            clientMessageId: body.clientMessageId,
            createdBy: session.actorId,
          });
          const created = await repos.studio.runs.create({
            threadId,
            triggerMessageId: appended.message.id,
            skillKey: skill.key,
            skillVersion: skill.version,
            idempotencyKey: `studio:${threadId}:${body.clientMessageId}`,
            promptVersions: {
              ...STUDIO_PROMPT_VERSIONS,
              skill: skill.version,
            },
          });
          if (created.replayed) {
            return {
              replayed: true as const,
              thread: bundle.thread,
              skill,
              run: created.run,
            };
          }
          if (!appended.replayed) {
            await repos.audit.write({
              workspaceId,
              actorId: session.actorId,
              entityId: appended.message.id,
              action: "studio.message.received",
              metadata: {
                threadId,
                messageId: appended.message.id,
                clientMessageId: body.clientMessageId,
                skillKey: skill.key,
              },
            });
          }
          const running = await repos.studio.runs.markRunning(created.run.id);
          if (!running) throw new Error("studio run could not be started");
          return {
            replayed: false as const,
            thread: bundle.thread,
            skill,
            run: running,
            operatorMessage: appended.message,
          };
        },
      );

      if (prepared.replayed) {
        return replayTurn(workspaceId, threadId, prepared.run);
      }

      const accounting: { usage: AIUsage | null; settledUsd: string | null } = {
        usage: null,
        settledUsd: null,
      };
      try {
        return await completeTurn({
          session,
          settings,
          workspaceId,
          threadId,
          run: prepared.run,
          skill: prepared.skill,
          body,
          now,
          limits,
          startedAt,
          recordUsage: (usage, settledUsd) => {
            accounting.usage = usage;
            accounting.settledUsd = settledUsd;
          },
        });
      } catch (error) {
        // A turn that already started running must never disappear silently:
        // mark it failed with a safe code and rethrow so the route reports it.
        const limitError =
          error instanceof StudioTurnDeadlineError ||
          error instanceof StudioTurnStepBudgetError
            ? error
            : null;
        const errorCode = (
          limitError
            ? limitError.code
            : error instanceof ApiError
              ? error.code
              : "studio_turn_failed"
        ).slice(0, 120);
        try {
          await database().forWorkspace(workspaceId, async (repos) => {
            await repos.studio.runs.fail(prepared.run.id, {
              errorCode,
              ...(accounting.usage
                ? {
                    provider: settings.ai?.provider ?? null,
                    model: accounting.usage.model,
                    inputTokens: accounting.usage.inputTokens,
                    outputTokens: accounting.usage.outputTokens,
                    estimatedCostUsd: formatUsd(
                      accounting.usage.estimatedCostUsd,
                    ),
                    settledUsd: accounting.settledUsd,
                  }
                : {}),
            });
            await repos.audit.write({
              workspaceId,
              actorId: session.actorId,
              entityId: prepared.run.id,
              action: "studio.run.failed",
              metadata: {
                threadId,
                runId: prepared.run.id,
                errorCode,
              },
            });
          });
        } catch (persistError) {
          console.error(
            JSON.stringify({
              event: "studio_run_failure_not_persisted",
              runId: prepared.run.id,
              errorName:
                persistError instanceof Error
                  ? persistError.name
                  : "UnknownError",
            }),
          );
        }
        emitStudioEvent(
          turnMetricEvent({
            status: "failed",
            durationMs: monotonicNow() - startedAt,
            toolSteps: limits.toolSteps,
            detailReads: limits.detailReads,
            modelCalls: limits.modelCalls,
            traceSteps: 0,
            outputCount: 0,
            limitationCount: 0,
            settledUsd: accounting.settledUsd,
            errorCode,
          }),
        );
        await emitBudgetAlert(workspaceId, settings);
        if (limitError)
          throw new ApiError(
            limitError instanceof StudioTurnDeadlineError ? 503 : 422,
            limitError.code,
            limitError instanceof StudioTurnDeadlineError
              ? "The turn exceeded its time budget; it was not completed."
              : "The turn exceeded its step budget; it was not completed.",
          );
        throw error;
      }
    },

    async getRun(threadId: string, runId: string): Promise<StudioRunResponse> {
      const { session, role } = await requireStudioSession(deps, "viewer");
      if (!UUID.safeParse(threadId).success || !UUID.safeParse(runId).success)
        throw studioNotFound();
      const result = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const bundle = await repos.studio.threads.getWithMessages(threadId, {
            messageLimit: 1,
          });
          if (!bundle) throw studioNotFound();
          assertThreadVisible(bundle.thread, session.actorId, role);
          const run = await repos.studio.runs.get(runId);
          if (!run || run.threadId !== threadId) throw studioNotFound();
          const events = await repos.studio.runEvents.list(runId);
          const reservation = await repos.studio.budget.getForRun(runId);
          return { run, events, reservation };
        },
      );
      return runView(result.run, result.events, result.reservation);
    },

    async overview(): Promise<StudioOverviewResult> {
      const { session } = await requireStudioSession(deps, "viewer");
      const data = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const [counts, quality, jobs] = await Promise.all([
            repos.listings.countByStatus(),
            repos.qualityProjection.read(),
            repos.pipelineRuns.listForWorkspace(5),
          ]);
          return { counts, quality, jobs };
        },
      );
      const byStatus: Record<string, number> = { ...data.counts };
      const total = Object.values(byStatus).reduce(
        (sum, count) => sum + count,
        0,
      );
      return {
        listingCounts: {
          byStatus,
          total,
          deepLink: "/dashboard",
        },
        quality: {
          assessmentVersion: data.quality.assessmentVersion,
          totalListings: data.quality.totalListings,
          totalAssessed: data.quality.totalAssessed,
          cleanCount: data.quality.cleanCount,
          hasGapsCount: data.quality.hasGapsCount,
          noActiveVersion: data.quality.noActiveVersion,
          unassessableActiveVersion: data.quality.unassessableActiveVersion,
          projectionState: data.quality.projection.state,
          asOf: data.quality.projection.asOf,
          deepLink: "/quality",
        },
        recentJobs: {
          items: data.jobs.map((job) => ({
            jobId: job.id,
            state: job.status,
            createdAt: job.createdAt.toISOString(),
            deepLink: "/jobs",
          })),
          deepLink: "/jobs",
        },
      };
    },

    /**
     * Read-only orchestration inbox (P3.1): one `forWorkspace` transaction reads
     * the same canonical records the overview/list pages use, then
     * `buildStudioInbox` classifies and bounds them. Viewer+ like overview; no
     * writes, no model calls and no new repository methods.
     */
    async inbox(): Promise<StudioInboxResult> {
      const { session, role } = await requireStudioSession(deps, "viewer");
      const data = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          // Each source is independent: one unreadable source marks its own
          // section unavailable instead of blanking the whole inbox. The
          // workspace transaction itself still fails closed above.
          const fulfilled = <T>(result: PromiseSettledResult<T>) =>
            result.status === "fulfilled" ? result.value : null;
          const [counts, quality, jobs, outputs, threads] =
            await Promise.allSettled([
              repos.listings.countByStatus(),
              repos.qualityProjection.read(),
              repos.pipelineRuns.listForWorkspace(20),
              repos.studio.outputs
                .list({ limit: 50 })
                .then((listed) => listed.items),
              // Visibility is applied in SQL before LIMIT so another user's
              // private thread never reaches the inbox aggregate.
              repos.studio.threads.list({
                limit: 20,
                viewerId: session.actorId,
                includePrivate: THREAD_ADMIN_ROLES.includes(role),
              }),
            ]);
          return {
            counts: fulfilled(counts),
            quality: fulfilled(quality),
            jobs: fulfilled(jobs),
            outputs: fulfilled(outputs),
            threads: fulfilled(threads)?.items ?? null,
          };
        },
      );
      return buildStudioInbox({
        now: clock(),
        listingCounts: data.counts,
        quality: data.quality
          ? {
              hasGapsCount: data.quality.hasGapsCount,
              noActiveVersion: data.quality.noActiveVersion,
              unassessableActiveVersion: data.quality.unassessableActiveVersion,
            }
          : null,
        jobs: data.jobs,
        outputs: data.outputs,
        threads: data.threads,
      });
    },

    /**
     * Admin Studio usage summary (A5.2): read-only projection of the last 30
     * days of runs, spend, MCP calls, threads and messages. Admin/owner only;
     * the workspace always comes from the resolved session.
     */
    async metrics(): Promise<StudioMetricsResult> {
      const { session } = await requireStudioSession(deps, "admin");
      const asOf = clock();
      const since = new Date(
        asOf.getTime() - STUDIO_METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const summary = await database().forWorkspace(
        session.workspaceId,
        (repos) => repos.studio.metrics.summary({ since }),
      );
      return {
        windowDays: STUDIO_METRICS_WINDOW_DAYS,
        since: since.toISOString(),
        asOf: asOf.toISOString(),
        runs: {
          total: safeCount(summary.runs.total),
          succeeded: safeCount(summary.runs.succeeded),
          failed: safeCount(summary.runs.failed),
          cancelled: safeCount(summary.runs.cancelled),
          outcomeUnknown: safeCount(summary.runs.outcomeUnknown),
          queuedOrRunning: safeCount(summary.runs.queuedOrRunning),
        },
        tokens: {
          input: decimalString(summary.tokens.input),
          output: decimalString(summary.tokens.output),
        },
        spendUsd: {
          settled: decimalString(summary.spend.settledUsd),
          reserved: decimalString(summary.spend.reservedUsd),
        },
        mcpCalls: {
          total: safeCount(summary.mcpCalls.total),
          ok: safeCount(summary.mcpCalls.ok),
          denied: safeCount(summary.mcpCalls.denied),
          error: safeCount(summary.mcpCalls.error),
          unavailable: safeCount(summary.mcpCalls.unavailable),
          schemaDrift: safeCount(summary.mcpCalls.schemaDrift),
        },
        threadsCreated: safeCount(summary.threadsCreated),
        messages: safeCount(summary.messages),
      };
    },

    async listOutputs(
      filters: StudioOutputListQuery = {},
    ): Promise<ListOutputsResult> {
      const { session } = await requireStudioSession(deps, "viewer");
      const parsed = studioOutputListQuerySchema.safeParse(filters);
      if (!parsed.success)
        throw new ApiError(400, "invalid_query", "Invalid query parameters.");
      const search = parsed.data.q?.trim();
      const offset = parsed.data.offset;
      const listed = await database().forWorkspace(
        session.workspaceId,
        (repos) =>
          repos.studio.outputs.list({
            limit: STUDIO_PAGE_SIZE,
            offset,
            ...(search ? { q: search } : {}),
            ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
            ...(parsed.data.status ? { status: parsed.data.status } : {}),
          }),
      );
      const items: StudioOutputSummary[] = listed.items.map((output) => ({
        outputId: output.id,
        kind: output.kind,
        title: output.title,
        status: output.status,
        currentVersion: output.currentVersion,
        threadId: output.threadId,
        createdAt: output.createdAt.toISOString(),
        updatedAt: output.updatedAt.toISOString(),
      }));
      return { items, truncated: listed.truncated, offset };
    },

    async getOutput(outputId: string): Promise<GetOutputResult> {
      const { session } = await requireStudioSession(deps, "viewer");
      if (!UUID.safeParse(outputId).success) throw studioNotFound();
      const bundle = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const output = await repos.studio.outputs.get(outputId);
          if (!output) return null;
          const versions = await repos.studio.outputs.versions(outputId);
          return { output, versions };
        },
      );
      if (!bundle) throw studioNotFound();
      const versions: StudioOutputVersionResponse[] = bundle.versions.map(
        (version) => ({
          revision: version.revision,
          payload: version.payload,
          contentDigest: version.contentDigest,
          asOf: version.asOf.toISOString(),
          scope: version.scope,
          createdBy: version.createdBy,
          createdAt: version.createdAt.toISOString(),
        }),
      );
      return {
        output: {
          outputId: bundle.output.id,
          kind: bundle.output.kind,
          title: bundle.output.title,
          status: bundle.output.status,
          currentVersion: bundle.output.currentVersion,
          threadId: bundle.output.threadId,
          createdAt: bundle.output.createdAt.toISOString(),
          updatedAt: bundle.output.updatedAt.toISOString(),
        },
        versions,
      };
    },

    async setOutputStatus(
      outputId: string,
      action: "save" | "sign_off",
    ): Promise<OutputActionResult> {
      const minimum = action === "sign_off" ? "reviewer" : "operator";
      const { session } = await requireStudioSession(deps, minimum);
      if (!UUID.safeParse(outputId).success) throw studioNotFound();
      const status = action === "sign_off" ? "signed_off" : "saved";
      return database().forWorkspace(session.workspaceId, async (repos) => {
        const output = await repos.studio.outputs.get(outputId);
        if (!output) throw studioNotFound();
        const changed = await repos.studio.outputs.setStatus(outputId, status);
        if (!changed)
          throw new ApiError(
            409,
            "output_without_version",
            "The output has no saved version.",
          );
        const readback = await repos.studio.outputs.get(outputId);
        if (!readback || readback.status !== status)
          throw new Error("studio_output_status_readback_mismatch");
        await repos.audit.write({
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          entityId: outputId,
          action:
            action === "sign_off"
              ? "studio.output.signed_off"
              : "studio.output.saved",
          metadata: {
            outputId,
            kind: output.kind,
            revision: readback.currentVersion,
            status,
          },
        });
        return {
          outputId,
          status: readback.status,
          version: readback.currentVersion,
        };
      });
    },
  };
}

export type StudioService = ReturnType<typeof createStudioService>;

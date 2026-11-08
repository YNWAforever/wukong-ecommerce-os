import { z } from "zod";

import type {
  AIUsage,
  StudioComposeInput,
  StudioModel,
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
  GetThreadResult,
  ListThreadsResult,
  SendMessageBody,
  StudioMessageResponse,
  StudioOverviewResult,
  StudioRunEventResponse,
  StudioRunResponse,
  StudioSendResult,
  StudioThreadResponse,
} from "./contracts.js";
import { STUDIO_DEFAULT_THREAD_TITLE } from "./contracts.js";
import {
  composeDeterministicReply,
  composeNeedsInputReply,
} from "./compose-deterministic.js";
import { buildEvidencePack } from "./evidence.js";
import { buildStudioReadDeps } from "./read-deps.js";
import {
  requireStudioSession,
  studioNotFound,
  type StudioDatabase,
  type StudioSessionDeps,
} from "./session.js";
import {
  translatedLine,
  turnReplySchema,
  type EvidencePack,
  type ModelAnalysis,
  type StudioTraceStep,
  type StudioTurnReply,
  type TranslatedLine,
  type TranslatedValues,
} from "./types.js";

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

function runView(run: StudioRun, events: StudioRunEvent[]): StudioRunResponse {
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
    reservedUsd: run.reservedUsd,
    settledUsd: run.settledUsd,
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

function skillPromptSummary(
  skill: SkillDefinition,
): StudioSkillPromptSummary {
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
  }): Promise<StudioSendResult> {
    const packResult = await database().forWorkspace(
      input.workspaceId,
      (repos) =>
        buildEvidencePack({
          skill: input.skill,
          deps: buildStudioReadDeps(repos),
          role: input.session.role,
          now: input.now,
          query: input.skill.inputs.some((field) => field.name === "query")
            ? input.body.text
            : null,
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
      const modelOutcome = await analyseTurn({
        workspaceId: input.workspaceId,
        settings: input.settings,
        run: input.run,
        skill: input.skill,
        pack: packResult.pack,
        body: input.body,
      });
      analysis = modelOutcome.analysis;
      usage = modelOutcome.usage;
      settledUsd = modelOutcome.settledUsd;
      if (modelOutcome.trace) trace.push(modelOutcome.trace);
      reply = turnReplySchema.parse({ ...deterministic, analysis });
    }

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
        if (!skill)
          throw new ApiError(400, "unknown_skill", "Unknown skill.");
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

    async listThreads(): Promise<ListThreadsResult> {
      const { session, role } = await requireStudioSession(deps, "viewer");
      const listed = await database().forWorkspace(
        session.workspaceId,
        (repos) => repos.studio.threads.list({ limit: 50 }),
      );
      return {
        items: listed.items
          .filter((thread) =>
            isThreadVisible(thread, session.actorId, role),
          )
          .map(threadView),
        truncated: listed.truncated,
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
            throw new ApiError(
              403,
              "insufficient_role",
              "Insufficient role.",
            );

          const content: Record<string, unknown> = {
            text: body.text,
            locale: body.locale,
            ...(body.skillKey ? { skillKey: body.skillKey } : {}),
            ...(body.attachmentAssetIds &&
            body.attachmentAssetIds.length > 0
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
          const running = await repos.studio.runs.markRunning(
            created.run.id,
          );
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
        });
      } catch (error) {
        // A turn that already started running must never disappear silently:
        // mark it failed with a safe code and rethrow so the route reports it.
        const errorCode = (
          error instanceof ApiError ? error.code : "studio_turn_failed"
        ).slice(0, 120);
        try {
          await database().forWorkspace(workspaceId, async (repos) => {
            await repos.studio.runs.fail(prepared.run.id, { errorCode });
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
        throw error;
      }
    },

    async getRun(
      threadId: string,
      runId: string,
    ): Promise<StudioRunResponse> {
      const { session, role } = await requireStudioSession(deps, "viewer");
      if (
        !UUID.safeParse(threadId).success ||
        !UUID.safeParse(runId).success
      )
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
          return { run, events };
        },
      );
      return runView(result.run, result.events);
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
          unassessableActiveVersion:
            data.quality.unassessableActiveVersion,
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
  };
}

export type StudioService = ReturnType<typeof createStudioService>;

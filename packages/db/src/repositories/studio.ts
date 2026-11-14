import { sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";

/**
 * Workspace-scoped repository for the Conversation Studio tables (migration
 * 0054). Every method runs inside a `db.forWorkspace` transaction, so the
 * workspace id is never a caller-supplied filter. Append-only tables expose
 * only insert/read paths, matching the migration's grants and triggers.
 */

const MONEY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;

function money(value: string, name: string, allowZero = false): string {
  if (
    !MONEY.test(value) ||
    (allowZero ? Number(value) < 0 : Number(value) <= 0)
  )
    throw new Error(`${name} must be a non-negative decimal string`);
  return value;
}

function digest(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${name} must be a sha256 hex digest`);
  return value;
}

function iso(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function text(value: unknown): string {
  return String(value);
}

/** Parse a count/bigint column without ever producing NaN/Infinity. */
function countOf(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : iso(value);
}

/** Postgres text[] literal for an empty or populated allowlist. */
function textArray(values: readonly string[]) {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`,`,
  )}]::text[]`;
}

/**
 * `%pattern%` for a case-insensitive LIKE/ILIKE with `%`, `_` and `\` in the
 * operator's search text treated as literal characters (used with ESCAPE '\').
 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export type StudioVisibility = "workspace" | "private";
export type StudioThreadStatus = "open" | "archived";
export type StudioMessageRole = "operator" | "assistant" | "system" | "tool";
export type StudioRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";
export type StudioRunEventKind =
  "tool" | "model" | "evidence" | "notice" | "error" | "dispatch";
export type StudioRunEventState =
  "started" | "done" | "failed" | "unavailable" | "blocked" | "info";
export type StudioOutputKind =
  "copy_proposal" | "gap_report" | "merchant_audit" | "finding";
export type StudioOutputStatus = "draft" | "saved" | "signed_off" | "discarded";
export type StudioBudgetState =
  "reserved" | "settled" | "released" | "uncertain";
export type StudioMcpConnectionStatus = "draft" | "approved" | "disabled";
export type StudioMcpCallStatus =
  "ok" | "unavailable" | "schema_drift" | "denied" | "error";

export type StudioAiSettings = {
  provider: "openrouter" | "opencode-go";
  model: string;
  pricingVersion: string;
  maxInputTokens: number;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  maxOutputTokens: number;
};

export type StudioSettings = {
  workspaceId: string;
  enabled: boolean;
  allowedSkills: string[];
  monthlyBudgetUsd: string | null;
  runCeilingUsd: string | null;
  retentionDays: number | null;
  defaultHome: boolean;
  ai: StudioAiSettings | null;
  updatedBy: string | null;
  updatedAt: Date | null;
};

/**
 * Workspace-scoped Studio usage aggregate for the admin usage summary (A5.2).
 *
 * Every numeric sum is a decimal string so it stays bigint-safe across the
 * postgres int8/numeric boundary; the counts are plain numbers. Only rows with
 * `created_at >= since` in this workspace contribute.
 */
export type StudioMetricsSummary = {
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    outcomeUnknown: number;
    queuedOrRunning: number;
  };
  tokens: { input: string; output: string };
  spend: { settledUsd: string; reservedUsd: string };
  mcpCalls: {
    total: number;
    ok: number;
    denied: number;
    error: number;
    unavailable: number;
    schemaDrift: number;
  };
  threadsCreated: number;
  messages: number;
};

export type StudioThread = {
  id: string;
  workspaceId: string;
  createdBy: string;
  title: string;
  skillKey: string | null;
  visibility: StudioVisibility;
  status: StudioThreadStatus;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StudioMessage = {
  id: string;
  workspaceId: string;
  threadId: string;
  sequence: number;
  role: StudioMessageRole;
  content: Record<string, unknown>;
  clientMessageId: string | null;
  runId: string | null;
  createdBy: string;
  createdAt: Date;
};

export type StudioRun = {
  id: string;
  workspaceId: string;
  threadId: string;
  triggerMessageId: string;
  status: StudioRunStatus;
  skillKey: string;
  skillVersion: string;
  provider: string | null;
  model: string | null;
  promptVersions: Record<string, unknown>;
  contextDigest: string | null;
  idempotencyKey: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  reservedUsd: string | null;
  settledUsd: string | null;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StudioRunEvent = {
  id: string;
  workspaceId: string;
  runId: string;
  sequence: number;
  kind: StudioRunEventKind;
  toolId: string | null;
  state: StudioRunEventState;
  payload: Record<string, unknown>;
  durationMs: number | null;
  createdAt: Date;
};

export type StudioOutput = {
  id: string;
  workspaceId: string;
  threadId: string | null;
  runId: string | null;
  kind: StudioOutputKind;
  title: string;
  status: StudioOutputStatus;
  currentVersion: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StudioOutputVersion = {
  id: string;
  workspaceId: string;
  outputId: string;
  revision: number;
  payload: Record<string, unknown>;
  contentDigest: string;
  asOf: Date;
  scope: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
};

export type StudioBudgetReservation = {
  id: string;
  workspaceId: string;
  runId: string;
  pricingVersion: string;
  reservedUsd: string;
  settledUsd: string | null;
  state: StudioBudgetState;
  createdAt: Date;
  updatedAt: Date;
};

export type StudioMcpConnection = {
  id: string;
  workspaceId: string;
  label: string;
  endpointUrl: string;
  transport: "http" | "sse";
  status: StudioMcpConnectionStatus;
  generation: number;
  toolAllowlist: string[];
  schemaHashes: Record<string, unknown>;
  credentialEnvelope: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StudioMcpCall = {
  id: string;
  workspaceId: string;
  runId: string | null;
  connectionId: string | null;
  /** Hosted-MCP token whose `tools/call` produced this row, when known. */
  tokenId: string | null;
  toolName: string;
  requestDigest: string;
  responseDigest: string | null;
  status: StudioMcpCallStatus;
  errorCode: string | null;
  latencyMs: number | null;
  caller: "agent" | "external_mcp";
  createdAt: Date;
};

export type StudioApiToken = {
  id: string;
  workspaceId: string;
  label: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  /** Rolling-minute tool-call limit; NULL means unlimited. */
  rateLimitPerMinute: number | null;
  /** UTC-month tool-call quota; NULL means unlimited. */
  monthlyCallQuota: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StudioSettingsInput = {
  enabled: boolean;
  allowedSkills: readonly string[];
  monthlyBudgetUsd: string | null;
  runCeilingUsd: string | null;
  retentionDays: number | null;
  defaultHome: boolean;
  ai: StudioAiSettings | null;
};

export type StudioRepository = {
  settings: {
    get(): Promise<StudioSettings>;
    upsert(
      input: StudioSettingsInput,
      actorId: string,
    ): Promise<StudioSettings>;
  };
  /**
   * Explicit admin-facing workspace-settings surface (Studio settings API).
   *
   * Same validated row as `settings`; named for the administrative use case so
   * callers do not have to know that `upsert` is the storage spelling. The
   * write runs inside the caller's `forWorkspace` transaction and returns the
   * persisted row, so a readback is a separate `get()` on the same repos.
   */
  workspaceSettings: {
    get(): Promise<StudioSettings>;
    update(
      input: StudioSettingsInput,
      actorId: string,
    ): Promise<StudioSettings>;
  };
  threads: {
    create(input: {
      createdBy: string;
      title: string;
      skillKey?: string | null;
      visibility?: StudioVisibility;
    }): Promise<StudioThread>;
    /**
     * `q` is matched case-insensitively against the title and skill key, with
     * `%`, `_` and `\` in the operator's text treated literally (LIKE escaping).
     * `offset` is an integer row offset applied after ORDER BY; the repository
     * reads `limit + 1` rows so `truncated` means "more rows after this page".
     *
     * `viewerId`/`includePrivate` apply the thread visibility rule in SQL
     * *before* LIMIT/OFFSET: workspace threads are visible to everyone, a
     * private thread only to its creator, and `includePrivate` (admin/owner)
     * lifts the private-thread restriction. Omitting `viewerId` keeps the
     * unfiltered read used by internal/administrative callers that already
     * enforce visibility themselves; list pages and the inbox must pass it.
     */
    list(input?: {
      limit?: number;
      before?: Date;
      q?: string;
      offset?: number;
      viewerId?: string;
      includePrivate?: boolean;
    }): Promise<{
      items: StudioThread[];
      truncated: boolean;
    }>;
    getWithMessages(
      id: string,
      input?: { messageLimit?: number; latest?: boolean },
    ): Promise<{ thread: StudioThread; messages: StudioMessage[] } | null>;
    touchLastMessage(id: string, at?: Date): Promise<void>;
    archive(id: string): Promise<boolean>;
  };
  messages: {
    findByClientMessageId(
      threadId: string,
      clientMessageId: string,
    ): Promise<StudioMessage | null>;
    append(input: {
      threadId: string;
      role: StudioMessageRole;
      content: Record<string, unknown>;
      clientMessageId?: string | null;
      runId?: string | null;
      createdBy: string;
    }): Promise<{ message: StudioMessage; replayed: boolean }>;
    list(
      threadId: string,
      input?: { limit?: number },
    ): Promise<StudioMessage[]>;
  };
  runs: {
    create(input: {
      threadId: string;
      triggerMessageId: string;
      skillKey: string;
      skillVersion: string;
      idempotencyKey: string;
      provider?: string | null;
      model?: string | null;
      promptVersions?: Record<string, unknown>;
      contextDigest?: string | null;
    }): Promise<{ run: StudioRun; replayed: boolean }>;
    markRunning(id: string): Promise<StudioRun | null>;
    complete(
      id: string,
      input: {
        provider?: string | null;
        model?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        estimatedCostUsd?: string | null;
        settledUsd?: string | null;
      },
    ): Promise<StudioRun | null>;
    fail(
      id: string,
      input: {
        errorCode: string;
        provider?: string | null;
        model?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        estimatedCostUsd?: string | null;
        settledUsd?: string | null;
        outcomeUnknown?: boolean;
      },
    ): Promise<StudioRun | null>;
    get(id: string): Promise<StudioRun | null>;
    findByIdempotencyKey(key: string): Promise<StudioRun | null>;
  };
  runEvents: {
    appendMany(
      runId: string,
      events: ReadonlyArray<{
        kind: StudioRunEventKind;
        state: StudioRunEventState;
        toolId?: string | null;
        payload?: Record<string, unknown>;
        durationMs?: number | null;
      }>,
    ): Promise<StudioRunEvent[]>;
    list(runId: string, input?: { limit?: number }): Promise<StudioRunEvent[]>;
  };
  outputs: {
    create(input: {
      threadId?: string | null;
      runId?: string | null;
      kind: StudioOutputKind;
      title: string;
      createdBy: string;
    }): Promise<StudioOutput>;
    addVersion(input: {
      outputId: string;
      payload: Record<string, unknown>;
      contentDigest: string;
      asOf: Date;
      scope?: Record<string, unknown>;
      createdBy: string;
    }): Promise<{ output: StudioOutput; version: StudioOutputVersion }>;
    get(
      id: string,
      input?: { forUpdate?: boolean },
    ): Promise<StudioOutput | null>;
    getVersion(
      id: string,
      revision: number,
    ): Promise<StudioOutputVersion | null>;
    statusConfirmation(id: string): Promise<{
      status: Exclude<StudioOutputStatus, "draft">;
      revision: number;
      contentDigest: string;
    } | null>;
    /**
     * `q` is a case-insensitive title search with LIKE wildcards escaped;
     * `kind`/`status` are exact filters. `offset` is applied after ORDER BY and
     * the repository reads `limit + 1` rows, so `truncated` means "more rows
     * after this page" and `items` never exceeds `limit`.
     */
    list(input?: {
      limit?: number;
      kind?: StudioOutputKind;
      status?: StudioOutputStatus;
      runId?: string;
      q?: string;
      offset?: number;
    }): Promise<{ items: StudioOutput[]; truncated: boolean }>;
    versions(outputId: string): Promise<StudioOutputVersion[]>;
    setStatus(
      id: string,
      status: Exclude<StudioOutputStatus, "draft">,
    ): Promise<boolean>;
  };
  budget: {
    getForRun(runId: string): Promise<StudioBudgetReservation | null>;
    reserve(input: {
      runId: string;
      pricingVersion: string;
      reservedUsd: string;
      workspaceCapUsd: string;
    }): Promise<{ accepted: boolean; state: StudioBudgetState | "blocked" }>;
    settle(runId: string, settledUsd: string): Promise<boolean>;
    release(runId: string): Promise<boolean>;
    markUncertain(runId: string): Promise<boolean>;
    committedUsd(): Promise<string>;
  };
  mcpConnections: {
    create(input: {
      label: string;
      endpointUrl: string;
      transport?: "http" | "sse";
      toolAllowlist: readonly string[];
      schemaHashes: Record<string, unknown>;
      credentialEnvelope?: string | null;
      createdBy: string;
    }): Promise<StudioMcpConnection>;
    list(): Promise<StudioMcpConnection[]>;
    get(id: string): Promise<StudioMcpConnection | null>;
    updateStatus(
      id: string,
      status: StudioMcpConnectionStatus,
      approvedBy?: string | null,
    ): Promise<StudioMcpConnection | null>;
    /**
     * Bind (or clear, with `null`) the encrypted credential envelope.
     *
     * A credential change bumps the generation and returns an approved
     * connection to `draft`: the approval decision was made for the old
     * generation, so it must be repeated. A disabled connection stays disabled.
     * The envelope is opaque ciphertext; this repository never decrypts it.
     */
    updateCredential(
      id: string,
      credentialEnvelope: string | null,
    ): Promise<StudioMcpConnection | null>;
    /**
     * Replace the pinned `{tool -> sha256(inputSchema)}` snapshot.
     *
     * Pinning new hashes is also a generation change and returns an approved
     * connection to `draft` for the same reason as `updateCredential`; a
     * disabled connection stays disabled.
     */
    updateSchemaHashes(
      id: string,
      schemaHashes: Record<string, unknown>,
    ): Promise<StudioMcpConnection | null>;
  };
  mcpCalls: {
    append(input: {
      runId?: string | null;
      connectionId?: string | null;
      /** Set for hosted-MCP calls so quotas can be counted per token. */
      tokenId?: string | null;
      toolName: string;
      requestDigest: string;
      responseDigest?: string | null;
      status: StudioMcpCallStatus;
      errorCode?: string | null;
      latencyMs?: number | null;
      caller: "agent" | "external_mcp";
    }): Promise<StudioMcpCall>;
    list(input?: {
      limit?: number;
      connectionId?: string;
    }): Promise<StudioMcpCall[]>;
    /**
     * Count this token's calls since `since` (inclusive-upper unbounded: all
     * rows at or after the instant). Used for the rolling-minute rate limit and
     * the UTC-month quota; rows for other tokens/workspaces never contribute.
     */
    countForTokenSince(tokenId: string, since: Date): Promise<number>;
  };
  /**
   * Read-only workspace usage aggregate (A5.2): one windowed read over runs,
   * budget reservations, MCP calls, threads and messages. No writes and no
   * cross-workspace rows.
   */
  metrics: {
    summary(input: { since: Date }): Promise<StudioMetricsSummary>;
  };
  apiTokens: {
    create(input: {
      label: string;
      tokenHash: string;
      prefix: string;
      scopes: readonly string[];
      createdBy: string;
      rateLimitPerMinute?: number | null;
      monthlyCallQuota?: number | null;
    }): Promise<StudioApiToken>;
    get(id: string): Promise<StudioApiToken | null>;
    findByHash(tokenHash: string): Promise<StudioApiToken | null>;
    revoke(id: string): Promise<boolean>;
    touch(id: string): Promise<void>;
    /** Count of non-revoked tokens in this workspace (quota guard). */
    countActive(): Promise<number>;
    /** Update both quota limits; false when the row is absent/revoked. */
    updateLimits(
      id: string,
      input: {
        rateLimitPerMinute: number | null;
        monthlyCallQuota: number | null;
      },
    ): Promise<boolean>;
    list(input?: { limit?: number }): Promise<StudioApiToken[]>;
  };
};

const DEFAULT_SETTINGS: Omit<StudioSettings, "workspaceId"> = {
  enabled: false,
  allowedSkills: [],
  monthlyBudgetUsd: null,
  runCeilingUsd: null,
  retentionDays: null,
  defaultHome: false,
  ai: null,
  updatedBy: null,
  updatedAt: null,
};

function readSettings(row: Record<string, unknown>): StudioSettings {
  const aiComplete =
    row.ai_provider != null &&
    row.ai_model != null &&
    row.pricing_version != null &&
    row.max_input_tokens != null &&
    row.input_usd_per_million != null &&
    row.output_usd_per_million != null &&
    row.max_output_tokens != null;
  return {
    workspaceId: text(row.workspace_id),
    enabled: Boolean(row.enabled),
    allowedSkills: Array.isArray(row.allowed_skills)
      ? row.allowed_skills.map(String)
      : [],
    monthlyBudgetUsd: nullableText(row.monthly_budget_usd),
    runCeilingUsd: nullableText(row.run_ceiling_usd),
    retentionDays:
      row.retention_days == null ? null : Number(row.retention_days),
    defaultHome: Boolean(row.default_home),
    ai: aiComplete
      ? {
          provider: text(row.ai_provider) as StudioAiSettings["provider"],
          model: text(row.ai_model),
          pricingVersion: text(row.pricing_version),
          maxInputTokens: Number(row.max_input_tokens),
          inputUsdPerMillion: text(row.input_usd_per_million),
          outputUsdPerMillion: text(row.output_usd_per_million),
          maxOutputTokens: Number(row.max_output_tokens),
        }
      : null,
    updatedBy: nullableText(row.updated_by),
    updatedAt: nullableDate(row.updated_at),
  };
}

function readThread(row: Record<string, unknown>): StudioThread {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    createdBy: text(row.created_by),
    title: text(row.title),
    skillKey: nullableText(row.skill_key),
    visibility: text(row.visibility) as StudioVisibility,
    status: text(row.status) as StudioThreadStatus,
    lastMessageAt: nullableDate(row.last_message_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function readMessage(row: Record<string, unknown>): StudioMessage {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    threadId: text(row.thread_id),
    sequence: Number(row.sequence),
    role: text(row.role) as StudioMessageRole,
    content: (row.content ?? {}) as Record<string, unknown>,
    clientMessageId: nullableText(row.client_message_id),
    runId: nullableText(row.run_id),
    createdBy: text(row.created_by),
    createdAt: iso(row.created_at),
  };
}

function readRun(row: Record<string, unknown>): StudioRun {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    threadId: text(row.thread_id),
    triggerMessageId: text(row.trigger_message_id),
    status: text(row.status) as StudioRunStatus,
    skillKey: text(row.skill_key),
    skillVersion: text(row.skill_version),
    provider: nullableText(row.provider),
    model: nullableText(row.model),
    promptVersions: (row.prompt_versions ?? {}) as Record<string, unknown>,
    contextDigest: nullableText(row.context_digest),
    idempotencyKey: text(row.idempotency_key),
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    estimatedCostUsd: nullableText(row.estimated_cost_usd),
    reservedUsd: nullableText(row.reserved_usd),
    settledUsd: nullableText(row.settled_usd),
    errorCode: nullableText(row.error_code),
    startedAt: nullableDate(row.started_at),
    finishedAt: nullableDate(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function readRunEvent(row: Record<string, unknown>): StudioRunEvent {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    runId: text(row.run_id),
    sequence: Number(row.sequence),
    kind: text(row.kind) as StudioRunEventKind,
    toolId: nullableText(row.tool_id),
    state: text(row.state) as StudioRunEventState,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: iso(row.created_at),
  };
}

function readOutput(row: Record<string, unknown>): StudioOutput {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    threadId: nullableText(row.thread_id),
    runId: nullableText(row.run_id),
    kind: text(row.kind) as StudioOutputKind,
    title: text(row.title),
    status: text(row.status) as StudioOutputStatus,
    currentVersion: Number(row.current_version),
    createdBy: text(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function readOutputVersion(row: Record<string, unknown>): StudioOutputVersion {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    outputId: text(row.output_id),
    revision: Number(row.revision),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    contentDigest: text(row.content_digest),
    asOf: iso(row.as_of),
    scope: (row.scope ?? {}) as Record<string, unknown>,
    createdBy: text(row.created_by),
    createdAt: iso(row.created_at),
  };
}

function readBudget(row: Record<string, unknown>): StudioBudgetReservation {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    runId: text(row.run_id),
    pricingVersion: text(row.pricing_version),
    reservedUsd: text(row.reserved_usd),
    settledUsd: nullableText(row.settled_usd),
    state: text(row.state) as StudioBudgetState,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function readMcpConnection(row: Record<string, unknown>): StudioMcpConnection {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    label: text(row.label),
    endpointUrl: text(row.endpoint_url),
    transport: text(row.transport) as "http" | "sse",
    status: text(row.status) as StudioMcpConnectionStatus,
    generation: Number(row.generation),
    toolAllowlist: Array.isArray(row.tool_allowlist)
      ? row.tool_allowlist.map(String)
      : [],
    schemaHashes: (row.schema_hashes ?? {}) as Record<string, unknown>,
    credentialEnvelope: nullableText(row.credential_envelope),
    createdBy: text(row.created_by),
    approvedBy: nullableText(row.approved_by),
    approvedAt: nullableDate(row.approved_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function readMcpCall(row: Record<string, unknown>): StudioMcpCall {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    runId: nullableText(row.run_id),
    connectionId: nullableText(row.connection_id),
    tokenId: nullableText(row.token_id),
    toolName: text(row.tool_name),
    requestDigest: text(row.request_digest),
    responseDigest: nullableText(row.response_digest),
    status: text(row.status) as StudioMcpCallStatus,
    errorCode: nullableText(row.error_code),
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    caller: text(row.caller) as "agent" | "external_mcp",
    createdAt: iso(row.created_at),
  };
}

function readApiToken(row: Record<string, unknown>): StudioApiToken {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    label: text(row.label),
    prefix: text(row.prefix),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    createdBy: text(row.created_by),
    revokedAt: nullableDate(row.revoked_at),
    lastUsedAt: nullableDate(row.last_used_at),
    rateLimitPerMinute:
      row.rate_limit_per_minute == null
        ? null
        : Number(row.rate_limit_per_minute),
    monthlyCallQuota:
      row.monthly_call_quota == null ? null : Number(row.monthly_call_quota),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function createStudioRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): StudioRepository {
  const settingsRepository: StudioRepository["settings"] = {
    async get() {
      scope.assertOpen();
      const rows = await transaction.execute(
        sql`select * from studio_workspace_settings where workspace_id=${workspaceId}`,
      );
      const row = rows[0];
      return row
        ? readSettings(row as Record<string, unknown>)
        : { workspaceId, ...DEFAULT_SETTINGS };
    },
    async upsert(input, actorId) {
      scope.assertOpen();
      if (
        input.retentionDays != null &&
        (input.retentionDays < 1 || input.retentionDays > 3650)
      )
        throw new Error("retentionDays must be between 1 and 3650");
      const monthly =
        input.monthlyBudgetUsd === null
          ? null
          : money(input.monthlyBudgetUsd, "monthlyBudgetUsd", true);
      const ceiling =
        input.runCeilingUsd === null
          ? null
          : money(input.runCeilingUsd, "runCeilingUsd", true);
      const ai = input.ai;
      if (ai) {
        money(ai.inputUsdPerMillion, "inputUsdPerMillion");
        money(ai.outputUsdPerMillion, "outputUsdPerMillion");
        if (ai.provider !== "openrouter" && ai.provider !== "opencode-go")
          throw new Error("unsupported studio ai provider");
      }
      const rows = await transaction.execute(sql`
        insert into studio_workspace_settings(
          workspace_id,enabled,allowed_skills,monthly_budget_usd,run_ceiling_usd,
          retention_days,default_home,ai_provider,ai_model,pricing_version,
          max_input_tokens,input_usd_per_million,output_usd_per_million,max_output_tokens,
          updated_by
        ) values (
          ${workspaceId},${input.enabled},${textArray(input.allowedSkills)},
          ${monthly}::numeric,${ceiling}::numeric,${input.retentionDays},
          ${input.defaultHome},${ai?.provider ?? null},${ai?.model ?? null},
          ${ai?.pricingVersion ?? null},${ai?.maxInputTokens ?? null},
          ${ai?.inputUsdPerMillion ?? null}::numeric,
          ${ai?.outputUsdPerMillion ?? null}::numeric,
          ${ai?.maxOutputTokens ?? null},${actorId}
        )
        on conflict (workspace_id) do update set
          enabled=excluded.enabled,
          allowed_skills=excluded.allowed_skills,
          monthly_budget_usd=excluded.monthly_budget_usd,
          run_ceiling_usd=excluded.run_ceiling_usd,
          retention_days=excluded.retention_days,
          default_home=excluded.default_home,
          ai_provider=excluded.ai_provider,
          ai_model=excluded.ai_model,
          pricing_version=excluded.pricing_version,
          max_input_tokens=excluded.max_input_tokens,
          input_usd_per_million=excluded.input_usd_per_million,
          output_usd_per_million=excluded.output_usd_per_million,
          max_output_tokens=excluded.max_output_tokens,
          updated_by=excluded.updated_by,
          updated_at=now()
        returning *
      `);
      return readSettings(rows[0] as Record<string, unknown>);
    },
  };

  return {
    settings: settingsRepository,

    workspaceSettings: {
      get: () => settingsRepository.get(),
      update: (input, actorId) => settingsRepository.upsert(input, actorId),
    },

    threads: {
      async create(input) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          insert into studio_threads(workspace_id,created_by,title,skill_key,visibility)
          values (
            ${workspaceId},${input.createdBy},${input.title},
            ${input.skillKey ?? null},${input.visibility ?? "workspace"}
          )
          returning *
        `);
        return readThread(rows[0] as Record<string, unknown>);
      },
      async list(input = {}) {
        scope.assertOpen();
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 50);
        const offset = Math.min(Math.max(input.offset ?? 0, 0), 100_000);
        const before = input.before ?? null;
        const search = input.q?.trim();
        const pattern = search ? likePattern(search) : null;
        const viewerId = input.viewerId ?? null;
        const includePrivate = input.includePrivate === true;
        const rows = await transaction.execute(sql`
          select * from studio_threads
          where workspace_id=${workspaceId}
            ${
              viewerId
                ? sql`and (visibility <> 'private' or created_by=${viewerId} or ${includePrivate}::boolean)`
                : sql``
            }
            ${before ? sql`and created_at < ${before.toISOString()}::timestamptz` : sql``}
            ${
              pattern
                ? sql`and (title ilike ${pattern} escape '\\' or coalesce(skill_key,'') ilike ${pattern} escape '\\')`
                : sql``
            }
          order by coalesce(last_message_at,created_at) desc, created_at desc, id desc
          limit ${limit + 1} offset ${offset}
        `);
        // Read one extra row so the caller can tell whether another page exists.
        const items = rows
          .slice(0, limit)
          .map((row) => readThread(row as Record<string, unknown>));
        return { items, truncated: rows.length > limit };
      },
      async getWithMessages(id, input = {}) {
        scope.assertOpen();
        const threads = await transaction.execute(
          sql`select * from studio_threads where workspace_id=${workspaceId} and id=${id}::uuid`,
        );
        const row = threads[0];
        if (!row) return null;
        const limit = Math.min(Math.max(input.messageLimit ?? 100, 1), 200);
        const messages = await transaction.execute(sql`
          select * from studio_messages
          where workspace_id=${workspaceId} and thread_id=${id}::uuid
          order by sequence ${input.latest ? sql`desc` : sql`asc`} limit ${limit}
        `);
        return {
          thread: readThread(row as Record<string, unknown>),
          messages: (input.latest ? [...messages].reverse() : messages).map(
            (message) => readMessage(message as Record<string, unknown>),
          ),
        };
      },
      async touchLastMessage(id, at = new Date()) {
        scope.assertOpen();
        await transaction.execute(sql`
          update studio_threads set last_message_at=${at.toISOString()}::timestamptz,updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid
        `);
      },
      async archive(id) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_threads set status='archived',updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid and status='open'
          returning id
        `);
        return rows.length > 0;
      },
    },

    messages: {
      async findByClientMessageId(threadId, clientMessageId) {
        scope.assertOpen();
        const rows = await transaction.execute(
          sql`select * from studio_messages where workspace_id=${workspaceId} and thread_id=${threadId}::uuid and client_message_id=${clientMessageId} limit 1`,
        );
        return rows[0] ? readMessage(rows[0] as Record<string, unknown>) : null;
      },
      async append(input) {
        scope.assertOpen();
        // Serializes the sequence allocation per thread.
        const threads = await transaction.execute(sql`
          select id from studio_threads
          where workspace_id=${workspaceId} and id=${input.threadId}::uuid
          for update
        `);
        if (!threads[0]) throw new Error("studio thread not found");
        const clientMessageId = input.clientMessageId ?? null;
        if (clientMessageId) {
          const existing = await transaction.execute(sql`
            select * from studio_messages
            where workspace_id=${workspaceId} and thread_id=${input.threadId}::uuid
              and client_message_id=${clientMessageId}
          `);
          if (existing[0])
            return {
              message: readMessage(existing[0] as Record<string, unknown>),
              replayed: true,
            };
        }
        const sequences = await transaction.execute(sql`
          select coalesce(max(sequence),0)+1 as next from studio_messages
          where workspace_id=${workspaceId} and thread_id=${input.threadId}::uuid
        `);
        const sequence = Number(sequences[0]?.next ?? 1);
        const rows = await transaction.execute(sql`
          insert into studio_messages(
            workspace_id,thread_id,sequence,role,content,client_message_id,run_id,created_by
          ) values (
            ${workspaceId},${input.threadId}::uuid,${sequence},${input.role},
            ${JSON.stringify(input.content)}::jsonb,${clientMessageId},${input.runId ?? null},
            ${input.createdBy}
          )
          returning *
        `);
        await transaction.execute(sql`
          update studio_threads set last_message_at=now(),updated_at=now()
          where workspace_id=${workspaceId} and id=${input.threadId}::uuid
        `);
        return {
          message: readMessage(rows[0] as Record<string, unknown>),
          replayed: false,
        };
      },
      async list(threadId, input = {}) {
        scope.assertOpen();
        const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
        const rows = await transaction.execute(sql`
          select * from studio_messages
          where workspace_id=${workspaceId} and thread_id=${threadId}::uuid
          order by sequence asc limit ${limit}
        `);
        return rows.map((row) => readMessage(row as Record<string, unknown>));
      },
    },

    runs: {
      async findByIdempotencyKey(key) {
        scope.assertOpen();
        const rows = await transaction.execute(
          sql`select * from studio_runs where workspace_id=${workspaceId} and idempotency_key=${key} limit 1`,
        );
        return rows[0] ? readRun(rows[0] as Record<string, unknown>) : null;
      },
      async create(input) {
        scope.assertOpen();
        if (!input.skillKey || input.skillKey.length > 120)
          throw new Error("skillKey is required");
        if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(input.skillVersion))
          throw new Error("skillVersion must be semver-like");
        if (
          !input.idempotencyKey ||
          input.idempotencyKey.length < 1 ||
          input.idempotencyKey.length > 200
        )
          throw new Error("idempotencyKey is required");
        const contextDigest =
          input.contextDigest == null
            ? null
            : digest(input.contextDigest, "contextDigest");
        const rows = await transaction.execute(sql`
          insert into studio_runs(
            workspace_id,thread_id,trigger_message_id,skill_key,skill_version,
            provider,model,prompt_versions,context_digest,idempotency_key
          ) values (
            ${workspaceId},${input.threadId}::uuid,${input.triggerMessageId}::uuid,
            ${input.skillKey},${input.skillVersion},${input.provider ?? null},
            ${input.model ?? null},${JSON.stringify(input.promptVersions ?? {})}::jsonb,
            ${contextDigest},${input.idempotencyKey}
          )
          on conflict (workspace_id,idempotency_key) do nothing
          returning *
        `);
        if (rows[0])
          return {
            run: readRun(rows[0] as Record<string, unknown>),
            replayed: false,
          };
        const existing = await transaction.execute(sql`
          select * from studio_runs
          where workspace_id=${workspaceId} and idempotency_key=${input.idempotencyKey}
        `);
        return {
          run: readRun(existing[0] as Record<string, unknown>),
          replayed: true,
        };
      },
      async markRunning(id) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_runs set status='running',started_at=coalesce(started_at,now()),updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid and status='queued'
          returning *
        `);
        return rows[0] ? readRun(rows[0] as Record<string, unknown>) : null;
      },
      async complete(id, input) {
        scope.assertOpen();
        const estimated =
          input.estimatedCostUsd == null
            ? null
            : money(input.estimatedCostUsd, "estimatedCostUsd", true);
        const settled =
          input.settledUsd == null
            ? null
            : money(input.settledUsd, "settledUsd", true);
        const rows = await transaction.execute(sql`
          update studio_runs set
            status='succeeded',finished_at=now(),updated_at=now(),
            provider=coalesce(${input.provider ?? null},provider),
            model=coalesce(${input.model ?? null},model),
            input_tokens=${input.inputTokens ?? null},
            output_tokens=${input.outputTokens ?? null},
            estimated_cost_usd=${estimated}::numeric,
            settled_usd=${settled}::numeric
          where workspace_id=${workspaceId} and id=${id}::uuid
            and status in ('queued','running')
          returning *
        `);
        return rows[0] ? readRun(rows[0] as Record<string, unknown>) : null;
      },
      async fail(id, input) {
        scope.assertOpen();
        if (!input.errorCode || input.errorCode.length > 120)
          throw new Error("errorCode is required");
        const status = input.outcomeUnknown ? "outcome_unknown" : "failed";
        const rows = await transaction.execute(sql`
          update studio_runs set
            status=${status},finished_at=now(),updated_at=now(),error_code=${input.errorCode},
            provider=coalesce(${input.provider ?? null},provider),
            model=coalesce(${input.model ?? null},model),
            input_tokens=${input.inputTokens ?? null},
            output_tokens=${input.outputTokens ?? null},
            estimated_cost_usd=${
              input.estimatedCostUsd == null
                ? null
                : money(input.estimatedCostUsd, "estimatedCostUsd", true)
            }::numeric,
            settled_usd=${
              input.settledUsd == null
                ? null
                : money(input.settledUsd, "settledUsd", true)
            }::numeric
          where workspace_id=${workspaceId} and id=${id}::uuid
            and status in ('queued','running')
          returning *
        `);
        return rows[0] ? readRun(rows[0] as Record<string, unknown>) : null;
      },
      async get(id) {
        scope.assertOpen();
        const rows = await transaction.execute(
          sql`select * from studio_runs where workspace_id=${workspaceId} and id=${id}::uuid`,
        );
        return rows[0] ? readRun(rows[0] as Record<string, unknown>) : null;
      },
    },

    runEvents: {
      async appendMany(runId, events) {
        scope.assertOpen();
        if (events.length === 0) return [];
        if (events.length > 64)
          throw new Error("at most 64 run events per call");
        const runs = await transaction.execute(sql`
          select id from studio_runs where workspace_id=${workspaceId} and id=${runId}::uuid
          for update
        `);
        if (!runs[0]) throw new Error("studio run not found");
        const sequences = await transaction.execute(sql`
          select coalesce(max(sequence),0) as current from studio_run_events
          where workspace_id=${workspaceId} and run_id=${runId}::uuid
        `);
        let next = Number(sequences[0]?.current ?? 0);
        const appended: StudioRunEvent[] = [];
        for (const event of events) {
          next += 1;
          const rows = await transaction.execute(sql`
            insert into studio_run_events(
              workspace_id,run_id,sequence,kind,tool_id,state,payload,duration_ms
            ) values (
              ${workspaceId},${runId}::uuid,${next},${event.kind},
              ${event.toolId ?? null},${event.state},${JSON.stringify(event.payload ?? {})}::jsonb,
              ${event.durationMs ?? null}
            )
            returning *
          `);
          appended.push(readRunEvent(rows[0] as Record<string, unknown>));
        }
        return appended;
      },
      async list(runId, input = {}) {
        scope.assertOpen();
        const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
        const rows = await transaction.execute(sql`
          select * from studio_run_events
          where workspace_id=${workspaceId} and run_id=${runId}::uuid
          order by sequence asc limit ${limit}
        `);
        return rows.map((row) => readRunEvent(row as Record<string, unknown>));
      },
    },

    outputs: {
      async create(input) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          insert into studio_outputs(workspace_id,thread_id,run_id,kind,title,created_by)
          values (
            ${workspaceId},${input.threadId ?? null}::uuid,${input.runId ?? null}::uuid,
            ${input.kind},${input.title},${input.createdBy}
          )
          returning *
        `);
        return readOutput(rows[0] as Record<string, unknown>);
      },
      async addVersion(input) {
        scope.assertOpen();
        const contentDigest = digest(input.contentDigest, "contentDigest");
        const rows = await transaction.execute(sql`
          select * from studio_outputs
          where workspace_id=${workspaceId} and id=${input.outputId}::uuid
          for update
        `);
        const output = rows[0];
        if (!output) throw new Error("studio output not found");
        const revision = Number(output.current_version) + 1;
        const versions = await transaction.execute(sql`
          insert into studio_output_versions(
            workspace_id,output_id,revision,payload,content_digest,as_of,scope,created_by
          ) values (
            ${workspaceId},${input.outputId}::uuid,${revision},${JSON.stringify(input.payload)}::jsonb,
            ${contentDigest},${input.asOf.toISOString()}::timestamptz,
            ${JSON.stringify(input.scope ?? {})}::jsonb,${input.createdBy}
          )
          returning *
        `);
        const updated = await transaction.execute(sql`
          update studio_outputs set current_version=${revision},status='draft',updated_at=now()
          where workspace_id=${workspaceId} and id=${input.outputId}::uuid
          returning *
        `);
        return {
          output: readOutput(updated[0] as Record<string, unknown>),
          version: readOutputVersion(versions[0] as Record<string, unknown>),
        };
      },
      async get(id, input = {}) {
        scope.assertOpen();
        const rows = await transaction.execute(
          sql`select * from studio_outputs where workspace_id=${workspaceId} and id=${id}::uuid ${input.forUpdate ? sql`for update` : sql``}`,
        );
        return rows[0] ? readOutput(rows[0] as Record<string, unknown>) : null;
      },
      async getVersion(id, revision) {
        scope.assertOpen();
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw new Error("invalid output revision");
        const rows = await transaction.execute(
          sql`select * from studio_output_versions where workspace_id=${workspaceId} and output_id=${id}::uuid and revision=${revision}`,
        );
        return rows[0]
          ? readOutputVersion(rows[0] as Record<string, unknown>)
          : null;
      },
      async statusConfirmation(id) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select a.action, a.metadata->>'revision' as revision, a.metadata->>'contentDigest' as content_digest
          from studio_outputs o
          join studio_output_versions v on v.workspace_id=o.workspace_id and v.output_id=o.id and v.revision=o.current_version
          join audit_events a on a.workspace_id=o.workspace_id and a.entity_id=o.id::text
          where o.workspace_id=${workspaceId} and o.id=${id}::uuid
            and o.status in ('saved','signed_off','discarded')
            and a.action=('studio.output.' || o.status)
            and a.metadata->>'revision'=o.current_version::text
            and a.metadata->>'contentDigest'=v.content_digest
          limit 1
        `);
        const row = rows[0];
        if (!row) return null;
        const revision = Number(row.revision);
        const contentDigest = nullableText(row.content_digest);
        if (
          !Number.isSafeInteger(revision) ||
          revision < 1 ||
          !contentDigest ||
          !/^[a-f0-9]{64}$/.test(contentDigest)
        )
          return null;
        const status = text(row.action).slice(
          "studio.output.".length,
        ) as Exclude<StudioOutputStatus, "draft">;
        return { status, revision, contentDigest };
      },
      async list(input = {}) {
        scope.assertOpen();
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
        const offset = Math.min(Math.max(input.offset ?? 0, 0), 100_000);
        const search = input.q?.trim();
        const pattern = search ? likePattern(search) : null;
        const kind = input.kind ?? null;
        const status = input.status ?? null;
        const rows = await transaction.execute(sql`
          select * from studio_outputs where workspace_id=${workspaceId}
            ${input.runId ? sql`and run_id=${input.runId}::uuid` : sql``}
            ${kind ? sql`and kind=${kind}` : sql``}
            ${status ? sql`and status=${status}` : sql``}
            ${pattern ? sql`and title ilike ${pattern} escape '\\'` : sql``}
          order by created_at desc, id desc limit ${limit + 1} offset ${offset}
        `);
        // See threads.list: the extra row is the has-more signal for the page.
        const items = rows
          .slice(0, limit)
          .map((row) => readOutput(row as Record<string, unknown>));
        return { items, truncated: rows.length > limit };
      },
      async versions(outputId) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select * from studio_output_versions
          where workspace_id=${workspaceId} and output_id=${outputId}::uuid
          order by revision desc
        `);
        return rows.map((row) =>
          readOutputVersion(row as Record<string, unknown>),
        );
      },
      async setStatus(id, status) {
        scope.assertOpen();
        if (!["saved", "signed_off", "discarded"].includes(status))
          throw new Error("unsupported studio output status");
        const rows = await transaction.execute(sql`
          update studio_outputs set status=${status},updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid and current_version>0
          returning id
        `);
        return rows.length > 0;
      },
    },

    budget: {
      async getForRun(runId) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select * from studio_budget_reservations
          where workspace_id=${workspaceId} and run_id=${runId}::uuid
        `);
        return rows[0] ? readBudget(rows[0] as Record<string, unknown>) : null;
      },
      async reserve(input) {
        scope.assertOpen();
        const reserved = money(input.reservedUsd, "reservedUsd");
        const cap = money(input.workspaceCapUsd, "workspaceCapUsd", true);
        if (!input.pricingVersion || input.pricingVersion.length > 128)
          throw new Error("pricingVersion is required");
        await transaction.execute(
          sql`select id from workspaces where id=${workspaceId} for no key update`,
        );
        const existing = await transaction.execute(sql`
          select state from studio_budget_reservations
          where workspace_id=${workspaceId} and run_id=${input.runId}::uuid
        `);
        if (existing[0])
          return {
            accepted: true,
            state: String(existing[0].state) as StudioBudgetState,
          };
        const inserted = await transaction.execute(sql`
          insert into studio_budget_reservations(
            workspace_id,run_id,pricing_version,reserved_usd,state
          )
          select ${workspaceId},${input.runId}::uuid,${input.pricingVersion},
            ${reserved}::numeric,'reserved'
          where (
            select coalesce(sum(case
              when state in ('reserved','settled','uncertain') then
                coalesce(settled_usd,reserved_usd)
              else 0 end),0)
            from studio_budget_reservations where workspace_id=${workspaceId}
          ) + ${reserved}::numeric <= ${cap}::numeric
          returning state
        `);
        return inserted[0]
          ? { accepted: true, state: "reserved" }
          : { accepted: false, state: "blocked" };
      },
      async settle(runId, settledUsd) {
        scope.assertOpen();
        const settled = money(settledUsd, "settledUsd", true);
        const rows = await transaction.execute(sql`
          update studio_budget_reservations
          set state='settled',settled_usd=${settled}::numeric,updated_at=now()
          where workspace_id=${workspaceId} and run_id=${runId}::uuid and state='reserved'
          returning id
        `);
        return rows.length > 0;
      },
      async release(runId) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_budget_reservations set state='released',updated_at=now()
          where workspace_id=${workspaceId} and run_id=${runId}::uuid and state='reserved'
          returning id
        `);
        return rows.length > 0;
      },
      async markUncertain(runId) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_budget_reservations set state='uncertain',updated_at=now()
          where workspace_id=${workspaceId} and run_id=${runId}::uuid and state='reserved'
          returning id
        `);
        return rows.length > 0;
      },
      async committedUsd() {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select coalesce(sum(case
            when state in ('reserved','settled','uncertain') then
              coalesce(settled_usd,reserved_usd)
            else 0 end),0)::text as committed
          from studio_budget_reservations where workspace_id=${workspaceId}
        `);
        return String(rows[0]?.committed ?? "0");
      },
    },

    mcpConnections: {
      async create(input) {
        scope.assertOpen();
        if (!input.endpointUrl.startsWith("https://"))
          throw new Error("MCP endpoints must be https");
        if (input.label.length < 1 || input.label.length > 100)
          throw new Error("label must be 1-100 characters");
        const rows = await transaction.execute(sql`
          insert into studio_mcp_connections(
            workspace_id,label,endpoint_url,transport,tool_allowlist,schema_hashes,
            credential_envelope,created_by
          ) values (
            ${workspaceId},${input.label},${input.endpointUrl},${input.transport ?? "http"},
            ${JSON.stringify(input.toolAllowlist)}::jsonb,
            ${JSON.stringify(input.schemaHashes)}::jsonb,
            ${input.credentialEnvelope ?? null},${input.createdBy}
          )
          returning *
        `);
        return readMcpConnection(rows[0] as Record<string, unknown>);
      },
      async list() {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select * from studio_mcp_connections where workspace_id=${workspaceId}
          order by created_at desc, id desc
        `);
        return rows.map((row) =>
          readMcpConnection(row as Record<string, unknown>),
        );
      },
      async get(id) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select * from studio_mcp_connections
          where workspace_id=${workspaceId} and id=${id}::uuid
        `);
        return rows[0]
          ? readMcpConnection(rows[0] as Record<string, unknown>)
          : null;
      },
      async updateStatus(id, status, approvedBy = null) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_mcp_connections set
            status=${status},
            approved_by=case when ${status}='approved' then ${approvedBy} else approved_by end,
            approved_at=case when ${status}='approved' then now() else approved_at end,
            updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid
          returning *
        `);
        return rows[0]
          ? readMcpConnection(rows[0] as Record<string, unknown>)
          : null;
      },
      async updateCredential(id, credentialEnvelope) {
        scope.assertOpen();
        if (
          credentialEnvelope !== null &&
          (credentialEnvelope.length < 1 || credentialEnvelope.length > 8192)
        )
          throw new Error("credential envelope length is invalid");
        const rows = await transaction.execute(sql`
          update studio_mcp_connections set
            credential_envelope=${credentialEnvelope},
            generation=generation + 1,
            status=case when status='approved' then 'draft' else status end,
            updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid
          returning *
        `);
        return rows[0]
          ? readMcpConnection(rows[0] as Record<string, unknown>)
          : null;
      },
      async updateSchemaHashes(id, schemaHashes) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_mcp_connections set
            schema_hashes=${JSON.stringify(schemaHashes)}::jsonb,
            generation=generation + 1,
            status=case when status='approved' then 'draft' else status end,
            updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid
          returning *
        `);
        return rows[0]
          ? readMcpConnection(rows[0] as Record<string, unknown>)
          : null;
      },
    },

    mcpCalls: {
      async append(input) {
        scope.assertOpen();
        const requestDigest = digest(input.requestDigest, "requestDigest");
        const responseDigest =
          input.responseDigest == null
            ? null
            : digest(input.responseDigest, "responseDigest");
        const rows = await transaction.execute(sql`
          insert into studio_mcp_calls(
            workspace_id,run_id,connection_id,token_id,tool_name,request_digest,
            response_digest,status,error_code,latency_ms,caller
          ) values (
            ${workspaceId},${input.runId ?? null}::uuid,
            ${input.connectionId ?? null}::uuid,${input.tokenId ?? null}::uuid,
            ${input.toolName},${requestDigest},
            ${responseDigest},${input.status},${input.errorCode ?? null},
            ${input.latencyMs ?? null},${input.caller}
          )
          returning *
        `);
        return readMcpCall(rows[0] as Record<string, unknown>);
      },
      async list(input = {}) {
        scope.assertOpen();
        const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
        const connectionId = input.connectionId ?? null;
        const rows = await transaction.execute(sql`
          select * from studio_mcp_calls where workspace_id=${workspaceId}
            ${connectionId ? sql`and connection_id=${connectionId}::uuid` : sql``}
          order by created_at desc, id desc limit ${limit}
        `);
        return rows.map((row) => readMcpCall(row as Record<string, unknown>));
      },
      async countForTokenSince(tokenId, since) {
        scope.assertOpen();
        // Serialize the instant explicitly: a raw Date reaches the prepared
        // statement binder as a JS object rather than a timestamptz literal.
        const rows = await transaction.execute(sql`
          select count(*)::int as count from studio_mcp_calls
          where workspace_id=${workspaceId}
            and token_id=${tokenId}::uuid
            and created_at >= ${since.toISOString()}::timestamptz
        `);
        return Number(rows[0]?.count ?? 0);
      },
    },

    metrics: {
      async summary(input) {
        scope.assertOpen();
        const sinceIso = input.since.toISOString();
        const [
          runTotals,
          runStatuses,
          reservations,
          mcpStatuses,
          threads,
          messages,
        ] = await Promise.all([
          transaction.execute(sql`
              select count(*)::bigint as total,
                coalesce(sum(input_tokens),0)::text as input_tokens,
                coalesce(sum(output_tokens),0)::text as output_tokens,
                coalesce(sum(settled_usd),0)::text as settled_usd
              from studio_runs
              where workspace_id=${workspaceId}
                and created_at >= ${sinceIso}::timestamptz
            `),
          transaction.execute(sql`
              select status, count(*)::bigint as count
              from studio_runs
              where workspace_id=${workspaceId}
                and created_at >= ${sinceIso}::timestamptz
              group by status
            `),
          transaction.execute(sql`
              select coalesce(sum(reserved_usd),0)::text as reserved_usd
              from studio_budget_reservations
              where workspace_id=${workspaceId}
                and created_at >= ${sinceIso}::timestamptz
            `),
          transaction.execute(sql`
              select status, count(*)::bigint as count
              from studio_mcp_calls
              where workspace_id=${workspaceId}
                and created_at >= ${sinceIso}::timestamptz
              group by status
            `),
          transaction.execute(sql`
              select count(*)::bigint as count from studio_threads
              where workspace_id=${workspaceId}
                and created_at >= ${sinceIso}::timestamptz
            `),
          transaction.execute(sql`
              select count(*)::bigint as count from studio_messages
              where workspace_id=${workspaceId}
                and created_at >= ${sinceIso}::timestamptz
            `),
        ]);

        const runByStatus = new Map<string, number>();
        for (const row of runStatuses) {
          const record = row as Record<string, unknown>;
          runByStatus.set(text(record.status), countOf(record.count));
        }
        const mcpByStatus = new Map<string, number>();
        for (const row of mcpStatuses) {
          const record = row as Record<string, unknown>;
          mcpByStatus.set(text(record.status), countOf(record.count));
        }
        const totalRuns = countOf(
          (runTotals[0] as Record<string, unknown> | undefined)?.total,
        );
        const totals = runTotals[0] as Record<string, unknown> | undefined;
        return {
          runs: {
            total: totalRuns,
            succeeded: runByStatus.get("succeeded") ?? 0,
            failed: runByStatus.get("failed") ?? 0,
            cancelled: runByStatus.get("cancelled") ?? 0,
            outcomeUnknown: runByStatus.get("outcome_unknown") ?? 0,
            queuedOrRunning:
              (runByStatus.get("queued") ?? 0) +
              (runByStatus.get("running") ?? 0),
          },
          tokens: {
            input: text(totals?.input_tokens ?? "0"),
            output: text(totals?.output_tokens ?? "0"),
          },
          spend: {
            settledUsd: text(totals?.settled_usd ?? "0"),
            reservedUsd: text(
              (reservations[0] as Record<string, unknown> | undefined)
                ?.reserved_usd ?? "0",
            ),
          },
          mcpCalls: {
            total: [...mcpByStatus.values()].reduce(
              (sum, count) => sum + count,
              0,
            ),
            ok: mcpByStatus.get("ok") ?? 0,
            denied: mcpByStatus.get("denied") ?? 0,
            error: mcpByStatus.get("error") ?? 0,
            unavailable: mcpByStatus.get("unavailable") ?? 0,
            schemaDrift: mcpByStatus.get("schema_drift") ?? 0,
          },
          threadsCreated: countOf(
            (threads[0] as Record<string, unknown> | undefined)?.count,
          ),
          messages: countOf(
            (messages[0] as Record<string, unknown> | undefined)?.count,
          ),
        } satisfies StudioMetricsSummary;
      },
    },

    apiTokens: {
      async create(input) {
        scope.assertOpen();
        const tokenHash = digest(input.tokenHash, "tokenHash");
        const rows = await transaction.execute(sql`
          insert into studio_api_tokens(
            workspace_id,label,token_hash,prefix,scopes,created_by,
            rate_limit_per_minute,monthly_call_quota
          ) values (
            ${workspaceId},${input.label},${tokenHash},${input.prefix},
            ${textArray(input.scopes)},${input.createdBy},
            ${input.rateLimitPerMinute ?? null},
            ${input.monthlyCallQuota ?? null}
          )
          returning *
        `);
        return readApiToken(rows[0] as Record<string, unknown>);
      },
      async get(id) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select * from studio_api_tokens
          where workspace_id=${workspaceId} and id=${id}::uuid
        `);
        return rows[0]
          ? readApiToken(rows[0] as Record<string, unknown>)
          : null;
      },
      async findByHash(tokenHash) {
        scope.assertOpen();
        const parsed = digest(tokenHash, "tokenHash");
        const rows = await transaction.execute(sql`
          select * from studio_api_tokens
          where workspace_id=${workspaceId} and token_hash=${parsed}
        `);
        return rows[0]
          ? readApiToken(rows[0] as Record<string, unknown>)
          : null;
      },
      async revoke(id) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_api_tokens set revoked_at=now(),updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid and revoked_at is null
          returning id
        `);
        return rows.length > 0;
      },
      async updateLimits(id, input) {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          update studio_api_tokens
          set rate_limit_per_minute=${input.rateLimitPerMinute},
            monthly_call_quota=${input.monthlyCallQuota},
            updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid
            and revoked_at is null
          returning id
        `);
        return rows.length > 0;
      },
      async touch(id) {
        scope.assertOpen();
        await transaction.execute(sql`
          update studio_api_tokens set last_used_at=now(),updated_at=now()
          where workspace_id=${workspaceId} and id=${id}::uuid
        `);
      },
      async list(input = {}) {
        scope.assertOpen();
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
        const rows = await transaction.execute(sql`
          select * from studio_api_tokens where workspace_id=${workspaceId}
          order by created_at desc, id desc limit ${limit}
        `);
        return rows.map((row) => readApiToken(row as Record<string, unknown>));
      },
      async countActive() {
        scope.assertOpen();
        const rows = await transaction.execute(sql`
          select count(*)::int as count from studio_api_tokens
          where workspace_id=${workspaceId} and revoked_at is null
        `);
        return Number((rows[0] as { count?: unknown } | undefined)?.count ?? 0);
      },
    },
  };
}

export type { StudioSettings as StudioSettingsRecord };

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { Locale } from "./locale";
import type { StudioCopyKey } from "./studio-copy";
import type {
  StudioMessageResponse,
  StudioRunEventResponse,
  StudioThreadResponse,
} from "./studio/contracts";
import {
  translatedLineSchema,
  turnReplySchema,
  type StudioTraceStep,
  type StudioTurnReply,
} from "./studio/types";

/**
 * Client state for one Studio conversation surface (plan Task 7).
 *
 * The wire contract is the Task 6 API, unchanged: creating a thread is
 * `POST /api/studio/threads`; sending is
 * `POST /api/studio/threads/[id]/messages` with a client-generated
 * `clientMessageId` (1..128), `text` (1..2000), an optional `skillKey`, an
 * optional `attachmentAssetIds` list and the operator locale. The server
 * answers synchronously, so this hook does no polling: after a successful send
 * the caller has the persisted reply and trace, and `refreshThread` exists for
 * an explicit reload.
 *
 * Three behaviours matter for correctness and are tested through it:
 *
 *  - **duplicate-submit prevention.** `send` sets an in-flight ref before its
 *    first `await`; a second call while a turn is running returns `null`
 *    immediately, so a double click cannot create two threads or two messages.
 *  - **one client message id per attempt.** `createStudioClientMessageId()`
 *    returns a fresh id for the first send; a retry must pass the same id so
 *    the server's replay path returns the existing reply instead of running a
 *    duplicate turn. The hook exposes `lastClientMessageId` for that retry.
 *  - **honest failure.** A failed create keeps the draft in the caller (this
 *    hook never owns the text); the error carries a copy key and, when a thread
 *    was already created, its id so a retry reuses that thread instead of
 *    leaving an empty one behind.
 */

const threadViewSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  skillKey: z.string().nullable(),
  visibility: z.enum(["workspace", "private"]),
  status: z.enum(["open", "archived"]),
  createdBy: z.string(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const messageViewSchema = z.object({
  messageId: z.string(),
  sequence: z.number(),
  role: z.enum(["operator", "assistant", "system", "tool"]),
  content: z.record(z.string(), z.unknown()),
  clientMessageId: z.string().nullable(),
  runId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});

export const getThreadResultSchema = z.object({
  thread: threadViewSchema,
  messages: z.array(messageViewSchema),
});

const traceStepSchema = z.object({
  kind: z.enum(["tool", "evidence", "model", "notice", "error", "dispatch"]),
  toolId: z.string().nullable(),
  state: z.enum([
    "started",
    "done",
    "failed",
    "unavailable",
    "blocked",
    "info",
  ]),
  durationMs: z.number().nullable(),
  detail: translatedLineSchema,
});

export const studioSendResultSchema = z.object({
  threadId: z.string(),
  messageId: z.string(),
  runId: z.string(),
  reply: turnReplySchema,
  trace: z.array(traceStepSchema),
  replayed: z.boolean(),
});

const createThreadResultSchema = z.object({ threadId: z.string() });

const runEventSchema = z.object({
  eventId: z.string(),
  sequence: z.number(),
  kind: z.string(),
  toolId: z.string().nullable(),
  state: z.string(),
  payload: z.record(z.string(), z.unknown()),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
});

const runResponseSchema = z.object({ events: z.array(runEventSchema) });

export type StudioSendSuccess = z.infer<typeof studioSendResultSchema> & {
  reply: StudioTurnReply;
  trace: StudioTraceStep[];
};

export type StudioSessionStatus = "idle" | "creating_thread" | "sending";

export type StudioSessionErrorKind =
  | "network"
  | "auth"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "server";

export type StudioSessionError = {
  readonly kind: StudioSessionErrorKind;
  readonly status: number | null;
  /** Copy key the caller renders; never a raw message from the response. */
  readonly copyKey: StudioCopyKey;
  /** Present when a thread was created before the failure, for a retry. */
  readonly threadId: string | null;
};

export type StudioSendInput = {
  readonly threadId: string | null;
  readonly text: string;
  readonly skillKey?: string | null;
  readonly attachmentAssetIds?: readonly string[];
  readonly locale: Locale;
  readonly clientMessageId: string;
};

export type StudioSendOutcome =
  | { readonly ok: true; readonly result: StudioSendSuccess }
  | { readonly ok: false; readonly error: StudioSessionError };

export type StudioRefreshOutcome =
  | {
      readonly ok: true;
      readonly thread: StudioThreadResponse;
      readonly messages: StudioMessageResponse[];
    }
  | { readonly ok: false; readonly error: StudioSessionError };

export type StudioSessionState = {
  status: StudioSessionStatus;
  inFlight: boolean;
  error: StudioSessionError | null;
  lastClientMessageId: string | null;
  createThread: (skillKey?: string | null) => Promise<string | null>;
  /** `null` means another turn is already in flight and nothing was sent. */
  send: (input: StudioSendInput) => Promise<StudioSendOutcome | null>;
  refreshThread: (threadId: string) => Promise<StudioRefreshOutcome>;
  /** `null` means the events could not be read; the caller shows that state. */
  loadRunTrace: (
    threadId: string,
    runId: string,
  ) => Promise<StudioTraceStep[] | null>;
  clearError: () => void;
};

let clientMessageSequence = 0;

/**
 * A client message id for one send attempt (1..128 chars).
 *
 * `crypto.randomUUID` exists in every supported browser and in Node; the
 * fallback keeps the hook testable and deterministic-shaped without depending
 * on a secure context.
 */
export function createStudioClientMessageId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  clientMessageSequence += 1;
  return `studio-${Date.now().toString(36)}-${clientMessageSequence}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

type HttpResult = { status: number; body: unknown };

class StudioRequestError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(`studio request failed (${status ?? "network"})`);
    this.name = "StudioRequestError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Map a failed request onto the one copy key the UI shows.
 *
 * Response bodies are never rendered: the server's message is diagnostic text
 * and could name internals, so only the HTTP status and the reviewed error
 * code choose localized copy.
 */
export function studioErrorCopyKey(
  status: number | null,
  code: string | null,
): { kind: StudioSessionError["kind"]; copyKey: StudioCopyKey } {
  if (status === null) {
    return { kind: "network", copyKey: "studio.error.network" };
  }
  if (status === 401) {
    return { kind: "auth", copyKey: "studio.error.auth" };
  }
  if (status === 403) {
    return { kind: "forbidden", copyKey: "studio.error.forbidden" };
  }
  if (status === 404) {
    return { kind: "not_found", copyKey: "studio.error.notFound" };
  }
  if (status === 429) {
    return { kind: "rate_limited", copyKey: "studio.error.tooManyRequests" };
  }
  if (status === 400) {
    return { kind: "invalid", copyKey: "studio.error.invalidBody" };
  }
  if (status === 409) {
    if (code === "run_in_progress") {
      return { kind: "conflict", copyKey: "studio.error.runInProgress" };
    }
    if (code === "run_outcome_unknown") {
      return { kind: "conflict", copyKey: "studio.honest.unknownOutcome" };
    }
    if (code === "run_incomplete") {
      return { kind: "conflict", copyKey: "studio.error.runIncomplete" };
    }
    return { kind: "conflict", copyKey: "studio.honest.runFailed" };
  }
  if (status >= 500) {
    return { kind: "unavailable", copyKey: "studio.error.unavailable" };
  }
  return { kind: "server", copyKey: "studio.error.generic" };
}

function asSessionError(
  error: unknown,
  threadId: string | null,
): StudioSessionError {
  if (error instanceof StudioRequestError) {
    const { kind, copyKey } = studioErrorCopyKey(error.status, error.code);
    return { kind, copyKey, status: error.status, threadId };
  }
  return {
    kind: "server",
    copyKey: "studio.error.generic",
    status: null,
    threadId,
  };
}

/** Persisted run events -> the render-facing trace step shape. */
function traceFromRunEvent(event: StudioRunEventResponse): StudioTraceStep {
  const kind = (
    ["tool", "evidence", "model", "notice", "error", "dispatch"] as const
  ).includes(
    event.kind as "tool" | "evidence" | "model" | "notice" | "error" | "dispatch",
  )
    ? (event.kind as StudioTraceStep["kind"])
    : "notice";
  const state = (
    ["started", "done", "failed", "unavailable", "blocked", "info"] as const
  ).includes(
    event.state as
      | "started"
      | "done"
      | "failed"
      | "unavailable"
      | "blocked"
      | "info",
  )
    ? (event.state as StudioTraceStep["state"])
    : "info";
  const payload = event.payload;
  const key = typeof payload.key === "string" ? payload.key : null;
  const rawValues = payload.values;
  const values: Record<string, string | number | boolean> = {};
  if (typeof rawValues === "object" && rawValues !== null) {
    for (const [name, value] of Object.entries(rawValues)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        values[name] = value;
      }
    }
  }
  return {
    kind,
    toolId: event.toolId,
    state,
    durationMs: event.durationMs,
    detail:
      key !== null
        ? { key, values }
        : { key: "studio.trace.unknown", values: {} },
  };
}

export function useStudioSession(): StudioSessionState {
  const [status, setStatus] = useState<StudioSessionStatus>("idle");
  const [error, setError] = useState<StudioSessionError | null>(null);
  const [lastClientMessageId, setLastClientMessageId] = useState<string | null>(
    null,
  );
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const createThread = useCallback(
    async (skillKey?: string | null): Promise<string | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setError(null);
      setStatus("creating_thread");
      try {
        let created: HttpResult;
        try {
          created = await postJson("/api/studio/threads", {
            ...(skillKey ? { skillKey } : {}),
          });
        } catch {
          throw new StudioRequestError(null, null);
        }
        if (created.status !== 201) {
          throw new StudioRequestError(created.status, errorCode(created.body));
        }
        const parsed = createThreadResultSchema.safeParse(created.body);
        if (!parsed.success) throw new StudioRequestError(500, null);
        return parsed.data.threadId;
      } catch (caught) {
        if (mountedRef.current) setError(asSessionError(caught, null));
        return null;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setStatus("idle");
      }
    },
    [],
  );

  const send = useCallback(
    async (input: StudioSendInput): Promise<StudioSendOutcome | null> => {
      // Synchronous guard: a double click cannot start two turns.
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setError(null);
      setLastClientMessageId(input.clientMessageId);

      let threadId = input.threadId;
      try {
        if (!threadId) {
          setStatus("creating_thread");
          let created: HttpResult;
          try {
            created = await postJson("/api/studio/threads", {
              ...(input.skillKey ? { skillKey: input.skillKey } : {}),
            });
          } catch {
            throw new StudioRequestError(null, null);
          }
          if (created.status !== 201) {
            throw new StudioRequestError(
              created.status,
              errorCode(created.body),
            );
          }
          const parsed = createThreadResultSchema.safeParse(created.body);
          if (!parsed.success) throw new StudioRequestError(500, null);
          threadId = parsed.data.threadId;
        }

        setStatus("sending");
        let response: HttpResult;
        try {
          response = await postJson(`/api/studio/threads/${threadId}/messages`, {
            clientMessageId: input.clientMessageId,
            text: input.text.slice(0, 2000),
            locale: input.locale,
            ...(input.skillKey ? { skillKey: input.skillKey } : {}),
            ...(input.attachmentAssetIds &&
            input.attachmentAssetIds.length > 0
              ? { attachmentAssetIds: [...input.attachmentAssetIds] }
              : {}),
          });
        } catch {
          throw new StudioRequestError(null, null);
        }
        if (response.status !== 200) {
          throw new StudioRequestError(
            response.status,
            errorCode(response.body),
          );
        }
        const parsed = studioSendResultSchema.safeParse(response.body);
        if (!parsed.success) throw new StudioRequestError(500, null);
        return { ok: true, result: parsed.data as StudioSendSuccess };
      } catch (caught) {
        const sessionError = asSessionError(caught, threadId);
        if (mountedRef.current) setError(sessionError);
        return { ok: false, error: sessionError };
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setStatus("idle");
      }
    },
    [],
  );

  const refreshThread = useCallback(
    async (threadId: string): Promise<StudioRefreshOutcome> => {
      // Deliberately does not set the shared `error` state: a reload failure
      // belongs next to the thread header, not in the composer's send alert.
      try {
        const response = await fetch(
          `/api/studio/threads/${encodeURIComponent(threadId)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (response.status !== 200) {
          throw new StudioRequestError(
            response.status,
            errorCode(await readJson(response)),
          );
        }
        const parsed = getThreadResultSchema.safeParse(await readJson(response));
        if (!parsed.success) throw new StudioRequestError(500, null);
        return {
          ok: true,
          thread: parsed.data.thread,
          messages: parsed.data.messages,
        };
      } catch (caught) {
        return { ok: false, error: asSessionError(caught, threadId) };
      }
    },
    [],
  );

  const loadRunTrace = useCallback(
    async (
      threadId: string,
      runId: string,
    ): Promise<StudioTraceStep[] | null> => {
      // The trace component owns this failure state; the composer must not show
      // a send error because an old run's events could not be read.
      try {
        const response = await fetch(
          `/api/studio/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (response.status !== 200) {
          throw new StudioRequestError(
            response.status,
            errorCode(await readJson(response)),
          );
        }
        const parsed = runResponseSchema.safeParse(await readJson(response));
        if (!parsed.success) throw new StudioRequestError(500, null);
        return parsed.data.events.map(traceFromRunEvent);
      } catch {
        return null;
      }
    },
    [],
  );

  return {
    status,
    inFlight: status !== "idle",
    error,
    lastClientMessageId,
    createThread,
    send,
    refreshThread,
    loadRunTrace,
    clearError,
  };
}

async function postJson(url: string, body: unknown): Promise<HttpResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  return { status: response.status, body: await readJson(response) };
}

/** Exposed for the thread view: a canonical message view built from a send. */
export function assistantMessageFromSend(
  result: StudioSendSuccess,
  sequence: number,
  createdAt: string,
): StudioMessageResponse {
  return {
    messageId: result.messageId,
    sequence,
    role: "assistant",
    content: result.reply as unknown as Record<string, unknown>,
    clientMessageId: null,
    runId: result.runId,
    createdBy: "studio",
    createdAt,
  };
}

/** A local operator message for optimistic display after a successful send. */
export function operatorMessageFromSend(input: {
  clientMessageId: string;
  sequence: number;
  locale: Locale;
  text: string;
  skillKey?: string | null;
  createdAt: string;
}): StudioMessageResponse {
  return {
    messageId: `local-operator-${input.clientMessageId}`,
    sequence: input.sequence,
    role: "operator",
    content: {
      text: input.text,
      locale: input.locale,
      ...(input.skillKey ? { skillKey: input.skillKey } : {}),
    },
    clientMessageId: input.clientMessageId,
    runId: null,
    createdBy: "local",
    createdAt: input.createdAt,
  };
}

/** Thread list entry the shell/tin roster renders; re-exported for props. */
export type StudioThreadListItem = Pick<
  StudioThreadResponse,
  | "threadId"
  | "title"
  | "skillKey"
  | "lastMessageAt"
  | "updatedAt"
  | "status"
>;

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import type {
  StudioMessageResponse,
  StudioThreadResponse,
} from "../lib/studio/contracts";
import type { StudioTraceStep } from "../lib/studio/types";
import {
  assistantMessageFromSend,
  createStudioClientMessageId,
  operatorMessageFromSend,
  useStudioSession,
} from "../lib/use-studio-session";
import { formatHkDate } from "../lib/ui-copy";
import { StudioComposer } from "./studio-composer";
import { StudioEvidence } from "./studio-evidence";
import {
  parseStudioAssistantContent,
  StudioTurn,
  type StudioTurnMessage,
} from "./studio-turn";
import styles from "./studio.module.css";

/**
 * One conversation thread (design spec §2.3).
 *
 * Server-rendered messages are the baseline; a completed send appends the
 * persisted operator/assistant turns locally (the server already stored them,
 * so this is display state, not optimistic data) together with the trace the
 * send returned. Traces for older replies load on demand from the run endpoint
 * when the operator opens the collapsed trace, which keeps a 100-message thread
 * from firing 100 requests on load.
 *
 * Failure behaviour is the product requirement: the draft and the client
 * message id stay so Retry re-sends the same turn (the server replays instead
 * of duplicating), the error is surfaced as localized copy rather than a
 * response body, and no success is shown before the server acknowledged.
 */

type TraceState = {
  steps: StudioTraceStep[] | null;
  loading: boolean;
  error: boolean;
};

type PendingAttempt = {
  text: string;
  skillKey: string | null;
  clientMessageId: string;
  threadId: string;
};

export type StudioThreadViewProps = {
  readonly locale: Locale;
  readonly thread: StudioThreadResponse;
  readonly messages: readonly StudioMessageResponse[];
  /** True when live analysis is configured for this workspace. */
  readonly aiEnabled: boolean;
  /** False for a viewer: sending needs operator+, and the UI says why. */
  readonly canSend: boolean;
  /** Reviewer-or-higher: gates artifact sign-off inside output cards. */
  readonly canSignOff: boolean;
};

function nextSequence(messages: readonly StudioMessageResponse[]): number {
  return messages.reduce((max, message) => Math.max(max, message.sequence), 0) + 1;
}

function toTurnMessage(message: StudioMessageResponse): StudioTurnMessage {
  return {
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    runId: message.runId,
  };
}

export function StudioThreadView({
  locale,
  thread,
  messages,
  aiEnabled,
  canSend,
  canSignOff,
}: StudioThreadViewProps) {
  const session = useStudioSession();
  const [serverMessages, setServerMessages] =
    useState<readonly StudioMessageResponse[]>(messages);
  const [localMessages, setLocalMessages] = useState<
    readonly StudioMessageResponse[]
  >([]);
  const [draft, setDraft] = useState("");
  const [skillKey, setSkillKey] = useState<string | null>(thread.skillKey);
  const [pendingClientMessageId, setPendingClientMessageId] = useState<
    string | null
  >(null);
  const [pendingAttempt, setPendingAttempt] =
    useState<PendingAttempt | null>(null);
  const [traces, setTraces] = useState<Record<string, TraceState>>({});
  const [replayed, setReplayed] = useState(false);
  const [reloadError, setReloadError] = useState<StudioCopyKey | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const visibleMessages = useMemo(
    () => [...serverMessages, ...localMessages],
    [serverMessages, localMessages],
  );

  const latestReply = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index];
      if (!message || message.role !== "assistant") continue;
      const reply = parseStudioAssistantContent(message.content);
      if (reply !== null) return reply;
    }
    return null;
  }, [visibleMessages]);

  // Newest turn stays in view. Reduced-motion users get no smooth scrolling.
  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pane = paneRef.current;
    if (pane) {
      if (prefersReducedMotion) {
        if (typeof pane.scrollTo === "function") {
          pane.scrollTo({ top: pane.scrollHeight, behavior: "auto" });
        } else {
          pane.scrollTop = pane.scrollHeight;
        }
      } else if (bottomRef.current?.scrollIntoView) {
        bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    }
  }, [visibleMessages.length, session.inFlight]);

  const loadTrace = useCallback(
    async (runId: string) => {
      setTraces((previous) => ({
        ...previous,
        [runId]: {
          steps: previous[runId]?.steps ?? null,
          loading: true,
          error: false,
        },
      }));
      const steps = await session.loadRunTrace(thread.threadId, runId);
      setTraces((previous) => ({
        ...previous,
        [runId]: { steps, loading: false, error: steps === null },
      }));
    },
    [session, thread.threadId],
  );

  const runSend = useCallback(
    async (attempt: PendingAttempt) => {
      const outcome = await session.send({
        threadId: attempt.threadId,
        text: attempt.text,
        skillKey: attempt.skillKey,
        locale,
        clientMessageId: attempt.clientMessageId,
      });
      // `null` = a turn was already in flight; the hook's error state (if any)
      // is rendered by the composer, and the attempt stays pending for Retry.
      if (outcome === null || !outcome.ok) return;
      const result = outcome.result;

      const sequenceBase = nextSequence(visibleMessages);
      const createdAt = new Date().toISOString();
      setLocalMessages((previous) => [
        ...previous,
        operatorMessageFromSend({
          clientMessageId: attempt.clientMessageId,
          sequence: sequenceBase,
          locale,
          text: attempt.text,
          skillKey: attempt.skillKey,
          createdAt,
        }),
        assistantMessageFromSend(result, sequenceBase + 1, createdAt),
      ]);
      setTraces((previous) => ({
        ...previous,
        [result.runId]: {
          steps: result.trace,
          loading: false,
          error: false,
        },
      }));
      setDraft("");
      setPendingClientMessageId(null);
      setPendingAttempt(null);
      setReplayed(result.replayed);
    },
    [locale, session, visibleMessages],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || !canSend || session.inFlight) return;
    const clientMessageId =
      pendingClientMessageId ?? createStudioClientMessageId();
    setPendingClientMessageId(clientMessageId);
    const attempt: PendingAttempt = {
      text,
      skillKey,
      clientMessageId,
      threadId: thread.threadId,
    };
    setPendingAttempt(attempt);
    void runSend(attempt);
  }, [
    canSend,
    draft,
    pendingClientMessageId,
    session.inFlight,
    skillKey,
    thread.threadId,
    runSend,
  ]);

  const handleRetry = useCallback(() => {
    if (pendingAttempt === null || session.inFlight) return;
    void runSend(pendingAttempt);
  }, [pendingAttempt, runSend, session.inFlight]);

  const handleReload = useCallback(() => {
    void (async () => {
      const outcome = await session.refreshThread(thread.threadId);
      if (!outcome.ok) {
        setReloadError(outcome.error.copyKey);
        return;
      }
      setReloadError(null);
      setServerMessages(outcome.messages);
      setLocalMessages([]);
      setTraces({});
      setReplayed(false);
    })();
  }, [session, thread.threadId]);

  // A send failure is the only shared-hook error this composer reports: trace
  // and reload failures have their own in-place states.
  const sendErrorKey: StudioCopyKey | null =
    pendingAttempt !== null ? (session.error?.copyKey ?? null) : null;

  return (
    <div className={styles["studio-thread"]}>
      <header className={styles["studio-thread-header"]}>
        <div className={styles["studio-thread-heading"]}>
          <p className={styles["studio-eyebrow"]}>
            {studioCopy(locale, "studio.thread.title")}
          </p>
          <h1 className={styles["studio-thread-title"]}>{thread.title}</h1>
        </div>
        <ul className={styles["studio-thread-meta"]}>
          <li className={styles["studio-badge"]} data-status={thread.status}>
            {studioCopy(
              locale,
              thread.status === "archived"
                ? "studio.thread.status.archived"
                : "studio.thread.status.open",
            )}
          </li>
          <li className={styles["studio-badge"]} data-visibility={thread.visibility}>
            {studioCopy(
              locale,
              thread.visibility === "private"
                ? "studio.thread.visibility.private"
                : "studio.thread.visibility.workspace",
            )}
          </li>
          <li className={styles["studio-badge"]}>
            {thread.skillKey
              ? `${studioCopy(locale, "studio.thread.skill")}: ${thread.skillKey}`
              : studioCopy(locale, "studio.thread.noSkill")}
          </li>
          <li className={styles["studio-thread-time"]}>
            {formatHkDate(thread.createdAt, locale)}
          </li>
        </ul>
        <div className={styles["studio-thread-actions"]}>
          <button
            type="button"
            className={styles["studio-secondary-button"]}
            onClick={handleReload}
          >
            {studioCopy(locale, "studio.thread.reload")}
          </button>
        </div>
      </header>

      <div className={styles["studio-thread-layout"]}>
        <div className={styles["studio-thread-main"]}>
          {reloadError ? (
            <div className={styles["studio-composer-error"]} role="alert">
              <p>{studioCopy(locale, reloadError)}</p>
              <button
                type="button"
                className={styles["studio-composer-retry"]}
                onClick={handleReload}
              >
                {studioCopy(locale, "studio.thread.reload")}
              </button>
            </div>
          ) : null}
          <div
            ref={paneRef}
            className={styles["studio-message-pane"]}
            aria-busy={session.inFlight}
          >
            {visibleMessages.length === 0 ? (
              <p className={styles["studio-empty"]}>
                {studioCopy(locale, "studio.thread.empty")}
              </p>
            ) : (
              <ol className={styles["studio-turn-list"]}>
                {visibleMessages.map((message) => {
                  const runId = message.runId;
                  const traceState = runId ? traces[runId] : undefined;
                  return (
                    <li key={message.messageId}>
                      <StudioTurn
                        locale={locale}
                        message={toTurnMessage(message)}
                        threadId={thread.threadId}
                        aiEnabled={aiEnabled}
                        canSignOff={canSignOff}
                        canDispatch={canSend}
                        trace={traceState?.steps ?? null}
                        traceLoading={traceState?.loading ?? false}
                        traceError={traceState?.error ?? false}
                        {...(runId
                          ? { onLoadTrace: () => void loadTrace(runId) }
                          : {})}
                      />
                    </li>
                  );
                })}
              </ol>
            )}
            <div ref={bottomRef} />
          </div>

          {replayed ? (
            <p className={styles["studio-notice"]} role="status">
              {studioCopy(locale, "studio.thread.replayed")}
            </p>
          ) : null}

          <div className={styles["studio-composer-sticky"]}>
            <StudioComposer
              locale={locale}
              id="studio-thread-composer"
              value={draft}
              onChange={setDraft}
              onSend={handleSend}
              {...(pendingAttempt ? { onRetry: handleRetry } : {})}
              sending={session.inFlight}
              error={sendErrorKey}
              sendDisabled={!canSend}
              sendDisabledReason="studio.composer.viewerNote"
              skillKey={skillKey}
              onClearSkill={() => setSkillKey(null)}
            />
          </div>
        </div>

        <aside
          className={styles["studio-thread-aside"]}
          aria-label={studioCopy(locale, "studio.evidence.title")}
        >
          {latestReply !== null ? (
            <StudioEvidence
              locale={locale}
              checks={latestReply.records.checks}
              coverage={latestReply.records.coverage}
            />
          ) : (
            <p className={styles["studio-empty"]}>
              {studioCopy(locale, "studio.thread.empty")}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

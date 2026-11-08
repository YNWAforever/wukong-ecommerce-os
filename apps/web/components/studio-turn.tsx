import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import {
  turnReplySchema,
  type ModelAnalysis,
  type StudioTraceStep,
  type StudioTurnReply,
} from "../lib/studio/types";
import { formatHkDate } from "../lib/ui-copy";
import { StudioEvidence } from "./studio-evidence";
import { StudioTrace } from "./studio-trace";
import styles from "./studio.module.css";

/**
 * One conversation turn: the operator's message, or the Studio reply.
 *
 * The reply is rendered from the persisted `StudioTurnReply` and nothing else —
 * no local recomputation, no inferred numbers. Assistant content is parsed
 * defensively: a row that does not satisfy the schema (for example one written
 * by a newer deployment) renders an honest invalid-content notice instead of
 * crashing the page or showing raw JSON.
 *
 * Rendering order follows design spec §2.3: "From your records" (sections,
 * check → result table, coverage chips), limitations, follow-ups, the collapsed
 * execution trace, and finally the separately labelled AI card. The AI card is
 * absent when no analysis was attempted; it says the model failed when the
 * attempt was recorded as failed, and it is the only place that repeats model
 * prose — always under the "unverified" label.
 */

const REPLY_STATUS_KEYS = {
  answered: "studio.thread.answered",
  partial: "studio.thread.partial",
  needs_input: "studio.thread.needsInput",
} as const satisfies Record<StudioTurnReply["status"], StudioCopyKey>;

/** The subset of a persisted message this component renders. */
export type StudioTurnMessage = {
  readonly messageId: string;
  readonly role: "operator" | "assistant" | "system" | "tool";
  readonly content: Record<string, unknown>;
  readonly createdAt: string;
  readonly runId?: string | null;
};

export type StudioOperatorContent = {
  readonly text: string;
  readonly locale?: Locale;
  readonly skillKey?: string;
};

/**
 * Parse persisted operator content: `{ text, locale, skillKey?, attachmentAssetIds? }`.
 * Anything else is invalid rather than partially rendered.
 */
export function parseStudioOperatorContent(
  content: Record<string, unknown>,
): StudioOperatorContent | null {
  const text = content.text;
  if (typeof text !== "string" || text.length === 0) return null;
  const skillKey =
    typeof content.skillKey === "string" && content.skillKey.length > 0
      ? content.skillKey
      : undefined;
  const rawLocale = content.locale;
  const locale: Locale | undefined =
    rawLocale === "zh-Hant" || rawLocale === "en" ? rawLocale : undefined;
  return {
    text,
    ...(locale ? { locale } : {}),
    ...(skillKey ? { skillKey } : {}),
  };
}

/** Parse persisted assistant content against the turn-reply schema. */
export function parseStudioAssistantContent(
  content: Record<string, unknown>,
): StudioTurnReply | null {
  const parsed = turnReplySchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

export type StudioTurnProps = {
  readonly locale: Locale;
  readonly message: StudioTurnMessage;
  /** Whether the workspace has live analysis configured for this request. */
  readonly aiEnabled?: boolean;
  /** Persisted trace steps for this turn, or `null` until loaded. */
  readonly trace?: StudioTraceStep[] | null;
  readonly traceLoading?: boolean;
  readonly traceError?: boolean;
  readonly onLoadTrace?: () => void;
};

function OperatorTurn({
  locale,
  message,
}: {
  locale: Locale;
  message: StudioTurnMessage;
}) {
  const content = parseStudioOperatorContent(message.content);
  return (
    <article
      className={styles["studio-turn-operator"]}
      data-role="operator"
      data-message-id={message.messageId}
    >
      <header className={styles["studio-turn-header"]}>
        <span className={styles["studio-turn-speaker"]}>
          {studioCopy(locale, "studio.thread.operatorTurn")}
        </span>
        <time
          className={styles["studio-turn-time"]}
          dateTime={message.createdAt}
        >
          {formatHkDate(message.createdAt, locale)}
        </time>
      </header>
      {content === null ? (
        <p className={styles["studio-turn-invalid"]} role="status">
          {studioCopy(locale, "studio.thread.invalidOperator")}
        </p>
      ) : (
        <>
          <p className={styles["studio-turn-text"]}>{content.text}</p>
          {content.skillKey ? (
            <p className={styles["studio-skill-chip"]}>
              <span className={styles["studio-skill-chip-label"]}>
                {studioCopy(locale, "studio.thread.skill")}
              </span>
              <span>{content.skillKey}</span>
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}

function ClaimsList({
  locale,
  analysis,
}: {
  locale: Locale;
  analysis: ModelAnalysis;
}) {
  return (
    <div className={styles["studio-model-claims"]}>
      <h4 className={styles["studio-evidence-subtitle"]}>
        {studioCopy(locale, "studio.model.claims")}
      </h4>
      {analysis.claims.length === 0 ? (
        <p className={styles["studio-evidence-note"]}>
          {studioCopy(locale, "studio.model.noClaims")}
        </p>
      ) : (
        <ul className={styles["studio-model-claim-list"]}>
          {analysis.claims.map((claim, index) => (
            <li key={`${index}-${claim.text.slice(0, 24)}`}>
              <p className={styles["studio-model-claim-text"]}>{claim.text}</p>
              <p className={styles["studio-model-claim-refs"]}>
                {renderStudioLine(locale, {
                  key: "studio.model.claimRefs",
                  values: { refs: claim.evidenceRefs.join(", ") },
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModelAnalysisCard({
  locale,
  analysis,
}: {
  locale: Locale;
  analysis: ModelAnalysis;
}) {
  const state = analysis.configured ? "configured" : "failed";
  return (
    <section
      className={styles["studio-model"]}
      data-model-state={state}
      aria-label={studioCopy(locale, "studio.model.title")}
    >
      <header className={styles["studio-model-header"]}>
        <h3 className={styles["studio-model-title"]}>
          {studioCopy(locale, "studio.model.title")}
        </h3>
        <span className={styles["studio-model-badge"]}>
          {studioCopy(locale, "studio.model.title")}
        </span>
      </header>
      {analysis.configured ? (
        <>
          <p className={styles["studio-model-note"]}>
            {studioCopy(locale, "studio.model.configured")}
          </p>
          {analysis.sections.map((section, index) => (
            <section key={`${index}-${section.heading}`}>
              <h4 className={styles["studio-model-heading"]}>
                {section.heading}
              </h4>
              <p className={styles["studio-model-body"]}>{section.body}</p>
            </section>
          ))}
          <ClaimsList locale={locale} analysis={analysis} />
          {analysis.droppedClaims > 0 ? (
            <p className={styles["studio-model-note"]}>
              {renderStudioLine(locale, {
                key: "studio.model.droppedClaims",
                values: { count: analysis.droppedClaims },
              })}
            </p>
          ) : null}
          {analysis.limitations.length > 0 ? (
            <ul className={styles["studio-model-limitations"]}>
              {analysis.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className={styles["studio-model-note"]} role="status">
          {studioCopy(locale, "studio.model.failed")}
        </p>
      )}
      <p className={styles["studio-model-limitation"]}>
        {studioCopy(locale, "studio.model.limitation")}
      </p>
    </section>
  );
}

function AssistantTurn({
  locale,
  message,
  aiEnabled,
  trace,
  traceLoading,
  traceError,
  onLoadTrace,
}: {
  locale: Locale;
  message: StudioTurnMessage;
} & Pick<
  StudioTurnProps,
  "aiEnabled" | "trace" | "traceLoading" | "traceError" | "onLoadTrace"
>) {
  const reply = parseStudioAssistantContent(message.content);
  if (reply === null) {
    return (
      <article
        className={styles["studio-turn"]}
        data-role="assistant"
        data-message-id={message.messageId}
      >
        <p className={styles["studio-turn-invalid"]} role="status">
          {studioCopy(locale, "studio.thread.invalidAssistant")}
        </p>
      </article>
    );
  }

  return (
    <article
      className={styles["studio-turn"]}
      data-role="assistant"
      data-message-id={message.messageId}
    >
      <header className={styles["studio-turn-header"]}>
        <span className={styles["studio-turn-speaker"]}>
          {studioCopy(locale, "studio.thread.assistantTurn")}
        </span>
        <span
          className={styles["studio-turn-status"]}
          data-status={reply.status}
        >
          {studioCopy(locale, REPLY_STATUS_KEYS[reply.status])}
        </span>
        <time
          className={styles["studio-turn-time"]}
          dateTime={message.createdAt}
        >
          {formatHkDate(message.createdAt, locale)}
        </time>
      </header>

      <section
        className={styles["studio-turn-records"]}
        aria-label={studioCopy(locale, "studio.evidence.title")}
      >
        {reply.records.sections.length > 0 ? (
          <ul className={styles["studio-answer-sections"]}>
            {reply.records.sections.map((line, index) => (
              <li key={`${index}-${line.key}`}>{renderStudioLine(locale, line)}</li>
            ))}
          </ul>
        ) : null}

        <StudioEvidence
          locale={locale}
          checks={reply.records.checks}
          coverage={reply.records.coverage}
          headingLevel="h4"
        />

        {reply.limitations.length > 0 ? (
          <div className={styles["studio-turn-list-block"]}>
            <h4 className={styles["studio-evidence-subtitle"]}>
              {studioCopy(locale, "studio.thread.limitations")}
            </h4>
            <ul className={styles["studio-turn-list"]}>
              {reply.limitations.map((line, index) => (
                <li key={`${index}-${line.key}`}>
                  {renderStudioLine(locale, line)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {reply.followUps.length > 0 ? (
          <div className={styles["studio-turn-list-block"]}>
            <h4 className={styles["studio-evidence-subtitle"]}>
              {studioCopy(locale, "studio.thread.followUps")}
            </h4>
            <ul className={styles["studio-followups"]}>
              {reply.followUps.map((line, index) => (
                <li key={`${index}-${line.key}`} className={styles["studio-followup"]}>
                  {renderStudioLine(locale, line)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <StudioTrace
        locale={locale}
        stepCount={reply.traceSummary.stepCount}
        steps={trace ?? null}
        loading={traceLoading}
        error={traceError}
        {...(onLoadTrace ? { onLoad: onLoadTrace } : {})}
      />

      {reply.analysis !== null ? (
        <ModelAnalysisCard locale={locale} analysis={reply.analysis} />
      ) : aiEnabled === false ? (
        <section
          className={styles["studio-model"]}
          data-model-state="not-configured"
          aria-label={studioCopy(locale, "studio.model.title")}
        >
          <h3 className={styles["studio-model-title"]}>
            {studioCopy(locale, "studio.model.title")}
          </h3>
          <p className={styles["studio-model-note"]}>
            {studioCopy(locale, "studio.model.notConfigured")}
          </p>
        </section>
      ) : null}
    </article>
  );
}

export function StudioTurn(props: StudioTurnProps) {
  if (props.message.role === "operator") {
    return <OperatorTurn locale={props.locale} message={props.message} />;
  }
  if (props.message.role === "assistant") {
    return <AssistantTurn {...props} />;
  }
  // system/tool messages are not operator- or assistant-facing turns.
  return null;
}

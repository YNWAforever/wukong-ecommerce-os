import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import type { StudioTraceStep } from "../lib/studio/types";
import { StudioRunDetails } from "./studio-run-details";
import styles from "./studio.module.css";

/**
 * The collapsed execution trace (design spec §2.3 step 2).
 *
 * Only persisted events are rendered: the parent passes the events the server
 * stored, or `null` when it has not loaded them yet. A step shows exactly the
 * state the run recorded — a failed or unavailable read keeps its own badge and
 * is never presented as `done` — plus the tool's readable name, its detail line
 * and a duration when one was stored.
 *
 * Details are copy keys with values; `renderStudioLine` owns interpolation and
 * its content-free fallback, so this component never renders a raw key.
 */

/**
 * Persisted run state -> copy key.
 *
 * Typed as a plain string map on purpose: a run event is persisted JSON, and a
 * newer deployment may record a state or kind this build does not know. The
 * lookups fall back to an honest generic label instead of rendering "undefined".
 * `running` is included even though the current deterministic service finishes
 * synchronously before it persists a step, because a slow turn can record it.
 */
const STATUS_KEYS: Readonly<Record<string, StudioCopyKey>> = {
  started: "studio.trace.status.started",
  running: "studio.trace.status.running",
  done: "studio.trace.status.done",
  failed: "studio.trace.status.failed",
  unavailable: "studio.trace.status.unavailable",
  blocked: "studio.trace.status.blocked",
  info: "studio.trace.status.info",
};

const KIND_KEYS: Readonly<Record<string, StudioCopyKey>> = {
  tool: "studio.trace.stepKind.tool",
  evidence: "studio.trace.stepKind.evidence",
  model: "studio.trace.stepKind.model",
  notice: "studio.trace.stepKind.notice",
  error: "studio.trace.stepKind.error",
  dispatch: "studio.trace.stepKind.dispatch",
};

function statusKey(state: string): StudioCopyKey {
  return STATUS_KEYS[state] ?? "studio.trace.status.info";
}

function kindKey(kind: string): StudioCopyKey {
  return KIND_KEYS[kind] ?? "studio.trace.stepKind.notice";
}

/** Readable tool names for the v1 registry; anything else falls back to copy. */
export const STUDIO_TOOL_LABEL_KEYS: Readonly<Record<string, StudioCopyKey>> = {
  "catalog.search": "studio.tool.catalog.search",
  "catalog.get": "studio.tool.catalog.get",
  "quality.get_gaps": "studio.tool.quality.get_gaps",
  "imports.list": "studio.tool.imports.list",
  "exports.get": "studio.tool.exports.get",
  "jobs.list": "studio.tool.jobs.list",
  "assets.list": "studio.tool.assets.list",
  "listing.get_run_status": "studio.tool.listing.get_run_status",
  "listing.create_draft": "studio.tool.listing.create_draft",
  "listing.propose_copy": "studio.tool.listing.propose_copy",
};

/**
 * Human name for a tool id.
 *
 * A known v1 tool uses its catalogue label. An id this build does not know —
 * for example an event written by a newer deployment — renders through the
 * renderer's `{tool}` fallback line instead of showing nothing or guessing.
 */
export function studioToolLabel(
  locale: Locale,
  toolId: string | null,
): string | null {
  if (!toolId) return null;
  const key = STUDIO_TOOL_LABEL_KEYS[toolId];
  if (key) return studioCopy(locale, key);
  return renderStudioLine(locale, {
    key: "studio.trace.toolId",
    values: { tool: toolId },
  });
}

export type StudioTraceProps = {
  readonly locale: Locale;
  /** `reply.traceSummary.stepCount`; the summary label uses the same number. */
  readonly stepCount: number;
  /** Persisted steps, or `null` until the parent loads them. */
  readonly steps: StudioTraceStep[] | null;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly onLoad?: () => void;
  readonly runContext?: { threadId: string; runId: string };
};

export function StudioTrace({
  locale,
  stepCount,
  steps,
  loading = false,
  error = false,
  onLoad,
  runContext,
}: StudioTraceProps) {
  const summary = renderStudioLine(locale, {
    key: "studio.trace.summary",
    values: { count: stepCount },
  });

  return (
    <details className={styles["studio-trace"]}>
      <summary className={styles["studio-trace-summary"]}>{summary}</summary>
      <div className={styles["studio-trace-body"]}>
        {runContext ? (
          <StudioRunDetails locale={locale} {...runContext} />
        ) : null}
        {steps === null ? (
          loading ? (
            <p className={styles["studio-trace-note"]} role="status">
              {studioCopy(locale, "studio.trace.loading")}
            </p>
          ) : error ? (
            <div className={styles["studio-trace-note"]} role="alert">
              <p>{studioCopy(locale, "studio.trace.error")}</p>
              {onLoad ? (
                <button
                  type="button"
                  className={styles["studio-trace-load"]}
                  onClick={onLoad}
                >
                  {studioCopy(locale, "studio.trace.load")}
                </button>
              ) : null}
            </div>
          ) : onLoad ? (
            <button
              type="button"
              className={styles["studio-trace-load"]}
              onClick={onLoad}
            >
              {studioCopy(locale, "studio.trace.load")}
            </button>
          ) : (
            <p className={styles["studio-trace-note"]}>
              {studioCopy(locale, "studio.trace.empty")}
            </p>
          )
        ) : steps.length === 0 ? (
          <p className={styles["studio-trace-note"]}>
            {studioCopy(locale, "studio.trace.empty")}
          </p>
        ) : (
          <ol className={styles["studio-trace-list"]}>
            {steps.map((step, index) => {
              const toolLabel = studioToolLabel(locale, step.toolId);
              return (
                <li
                  key={`${index}-${step.kind}-${step.toolId ?? "none"}`}
                  className={styles["studio-trace-step"]}
                  data-state={step.state}
                  data-kind={step.kind}
                >
                  <div className={styles["studio-trace-step-header"]}>
                    <span className={styles["studio-trace-step-kind"]}>
                      {studioCopy(locale, kindKey(step.kind))}
                    </span>
                    {toolLabel ? (
                      <span className={styles["studio-trace-step-tool"]}>
                        {toolLabel}
                      </span>
                    ) : null}
                    <span
                      className={styles["studio-trace-status"]}
                      data-state={step.state}
                    >
                      {studioCopy(locale, statusKey(step.state))}
                    </span>
                  </div>
                  <p className={styles["studio-trace-detail"]}>
                    {renderStudioLine(locale, step.detail)}
                  </p>
                  {step.durationMs !== null ? (
                    <span className={styles["studio-trace-duration"]}>
                      {renderStudioLine(locale, {
                        key: "studio.trace.duration",
                        values: { duration: step.durationMs },
                      })}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </details>
  );
}

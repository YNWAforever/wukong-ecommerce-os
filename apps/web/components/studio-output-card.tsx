"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { z } from "zod";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import { formatHkDate } from "../lib/ui-copy";
import { StudioReviewCard } from "./studio-review-card";
import { StudioFindingCard } from "./studio-finding-card";
import { StudioReportCard } from "./studio-report-card";
import styles from "./studio.module.css";

/**
 * One persisted Studio output artifact (plan Task 9, design spec §2.3 step 5).
 *
 * Given only `{ outputId, revision }` from a turn reply (or a list row on the
 * outputs page), the card reads the artifact from `GET /api/studio/outputs/[id]`
 * and renders its newest version: kind, title, status chip, current version,
 * as-of time and a short content digest, with the copy-proposal review card
 * inline for `copy_proposal` payloads.
 *
 * The two mutating actions follow the reviewed contract and the honesty rule:
 *
 *  - `save` and `sign_off` POST `{action}` and prove nothing until the response
 *    arrives — the card updates its status/version **from the server response**
 *    (both routes re-read the persisted version), never optimistically.
 *  - Sign-off requires reviewer-or-higher. The action is disabled with the role
 *    reason rather than attempted and failed, and a 403 that still arrives is
 *    reported with the same honest role copy.
 *
 * The component is `expandable` on the outputs page so a long list does not
 * fetch every artifact up front; inside a thread the card loads immediately
 * because the operator already asked for that turn's output.
 */

const outputStatusSchema = z.enum([
  "draft",
  "saved",
  "signed_off",
  "discarded",
]);
export type StudioOutputStatus = z.infer<typeof outputStatusSchema>;

const studioOutputViewSchema = z.object({
  outputId: z.string().min(1).max(200),
  kind: z.string().min(1).max(80),
  title: z.string().max(300),
  status: outputStatusSchema,
  currentVersion: z.number().int().min(1),
  threadId: z.string().max(200).nullable().optional(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
});
export type StudioOutputView = z.infer<typeof studioOutputViewSchema>;

const studioOutputVersionSchema = z.object({
  revision: z.number().int().min(1),
  payload: z.record(z.string(), z.unknown()),
  contentDigest: z.string().min(1).max(128),
  asOf: z.string().min(1).max(64),
  scope: z.unknown(),
  createdBy: z.string().max(200),
  createdAt: z.string().max(64),
});
export type StudioOutputVersionView = z.infer<typeof studioOutputVersionSchema>;

export const studioOutputDetailSchema = z.object({
  output: studioOutputViewSchema,
  versions: z.array(studioOutputVersionSchema).min(1),
});
export type StudioOutputDetail = z.infer<typeof studioOutputDetailSchema>;

export const studioOutputActionResultSchema = z.object({
  outputId: z.string().min(1).max(200),
  status: outputStatusSchema,
  version: z.number().int().min(1),
});

/**
 * `GET /api/studio/outputs/[id]/receipt` response (B3 follow-up). The card
 * only displays what the server computed; it never derives a signature or
 * claims verification beyond this payload.
 */
const exportReceiptSchema = z.object({
  alg: z.literal("HMAC-SHA256"),
  keyId: z.string().min(1).max(40),
  signedAt: z.string().min(1).max(64),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});

const studioOutputReceiptSchema = z.object({
  schemaVersion: z.string().min(1).max(80),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputId: z.string().min(1).max(200),
  revision: z.number().int().min(1),
  asOf: z.string().min(1).max(64),
  keyConfigured: z.boolean(),
  signed: z.boolean(),
  receipt: exportReceiptSchema.nullable(),
});
export type StudioOutputReceipt = z.infer<typeof studioOutputReceiptSchema>;

type ReceiptState =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "signed"; keyId: string; signature: string }
  | { phase: "unsigned" }
  | { phase: "failed" };

/** A list row from `GET /api/studio/outputs`. */
export const studioOutputListItemSchema = studioOutputViewSchema.pick({
  outputId: true,
  kind: true,
  title: true,
  status: true,
  currentVersion: true,
  createdAt: true,
  updatedAt: true,
});
export type StudioOutputListItem = z.infer<typeof studioOutputListItemSchema>;

/** Normalize a wire status; unknown values are not rendered as a status chip. */
export function toOutputStatus(value: unknown): StudioOutputStatus | null {
  const parsed = outputStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const STATUS_KEYS: Readonly<Record<StudioOutputStatus, StudioCopyKey>> = {
  draft: "studio.signoff.draft",
  saved: "studio.signoff.saved",
  signed_off: "studio.signoff.signedOff",
  discarded: "studio.signoff.discarded",
};

const OUTPUT_KIND_KEYS: Readonly<Record<string, StudioCopyKey>> = {
  copy_proposal: "studio.outputs.kind.copy_proposal",
  gap_report: "studio.outputs.kind.gap_report",
  merchant_audit: "studio.outputs.kind.merchant_audit",
  finding: "studio.outputs.kind.finding",
};

type ActionState = "idle" | "saving" | "signing_off";

type HttpResult = { status: number; body: unknown };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<HttpResult> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  return { status: response.status, body: await readJson(response) };
}

async function postAction(
  url: string,
  action: "save" | "sign_off",
): Promise<HttpResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
    cache: "no-store",
    credentials: "same-origin",
  });
  return { status: response.status, body: await readJson(response) };
}

/** Map a failed artifact read onto the one copy key the card shows. */
export function outputLoadErrorKey(status: number | null): StudioCopyKey {
  if (status === 401) return "studio.error.auth";
  if (status === 403) return "studio.error.forbidden";
  if (status === 404) return "studio.error.notFound";
  return "studio.outputs.loadError";
}

/** Map a failed save/sign-off onto honest copy; role failures say so. */
export function outputActionErrorKey(input: {
  action: "save" | "sign_off";
  status: number | null;
}): StudioCopyKey {
  if (input.status === 403) {
    return input.action === "sign_off"
      ? "studio.outputs.signOffRole"
      : "studio.error.forbidden";
  }
  if (input.status === 401) return "studio.error.auth";
  if (input.status === 404) return "studio.error.notFound";
  if (input.status === null) return "studio.error.network";
  return input.action === "save"
    ? "studio.outputs.saveFailed"
    : "studio.outputs.signOffFailed";
}

function latestVersion(
  versions: readonly StudioOutputVersionView[],
): StudioOutputVersionView {
  return versions.reduce((latest, version) =>
    version.revision > latest.revision ? version : latest,
  );
}

export type StudioOutputCardProps = {
  readonly locale: Locale;
  readonly outputId: string;
  /** Revision referenced by the turn reply, used only in the fallback meta. */
  readonly revision?: number | null;
  /** Reviewer-or-higher; supplied by the server page, never inferred here. */
  readonly canSignOff: boolean;
  /**
   * Render as a collapsed `<details>` row that loads only when opened. The
   * outputs page uses this; a thread renders the card immediately.
   */
  readonly expandable?: boolean;
  /** Optional list-row summary so the collapsed row is honest before loading. */
  readonly initialSummary?: {
    readonly kind?: string | null;
    readonly title?: string | null;
    readonly status?: StudioOutputStatus | null;
  } | null;
};

export function StudioOutputCard({
  locale,
  outputId,
  revision = null,
  canSignOff,
  expandable = false,
  initialSummary = null,
}: StudioOutputCardProps) {
  const [detail, setDetail] = useState<StudioOutputDetail | null>(null);
  // A non-expandable card starts fetching immediately, so its first paint is
  // the honest loading state (also what server-side rendering shows); an
  // expandable row shows no body until the operator opens it.
  const [loading, setLoading] = useState(!expandable);
  const [loadError, setLoadError] = useState<StudioCopyKey | null>(null);
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [actionError, setActionError] = useState<StudioCopyKey | null>(null);
  const [notice, setNotice] = useState<StudioCopyKey | null>(null);
  const [receiptState, setReceiptState] = useState<ReceiptState>({
    phase: "idle",
  });
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await getJson(
        `/api/studio/outputs/${encodeURIComponent(outputId)}`,
      );
      if (result.status !== 200) {
        setLoadError(outputLoadErrorKey(result.status));
        return;
      }
      const parsed = studioOutputDetailSchema.safeParse(result.body);
      if (!parsed.success) {
        setLoadError("studio.outputs.loadError");
        return;
      }
      setDetail(parsed.data);
    } catch {
      setLoadError("studio.error.network");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [outputId]);

  useEffect(() => {
    if (!expandable) void load();
  }, [expandable, load]);

  const handleToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      if (!event.currentTarget.open) return;
      if (detail === null && !loading && loadError === null) void load();
    },
    [detail, load, loadError, loading],
  );

  const runAction = useCallback(
    async (action: "save" | "sign_off") => {
      if (inFlight.current) return;
      inFlight.current = true;
      setActionState(action === "save" ? "saving" : "signing_off");
      setActionError(null);
      setNotice(null);
      try {
        const result = await postAction(
          `/api/studio/outputs/${encodeURIComponent(outputId)}`,
          action,
        );
        if (result.status !== 200) {
          setActionError(
            outputActionErrorKey({ action, status: result.status }),
          );
          return;
        }
        const parsed = studioOutputActionResultSchema.safeParse(result.body);
        if (!parsed.success) {
          setActionError(
            action === "save"
              ? "studio.outputs.saveFailed"
              : "studio.outputs.signOffFailed",
          );
          return;
        }
        // The response is the readback: nothing is claimed before this point.
        setDetail((previous) =>
          previous === null
            ? previous
            : {
                ...previous,
                output: {
                  ...previous.output,
                  status: parsed.data.status,
                  currentVersion: parsed.data.version,
                },
              },
        );
        setNotice(
          action === "save"
            ? "studio.outputs.saveSucceeded"
            : "studio.outputs.signOffSucceeded",
        );
      } catch {
        setActionError(
          action === "save"
            ? "studio.outputs.saveFailed"
            : "studio.outputs.signOffFailed",
        );
      } finally {
        inFlight.current = false;
        setActionState("idle");
      }
    },
    [outputId],
  );

  const status = detail?.output.status ?? initialSummary?.status ?? null;
  const title = detail?.output.title ?? initialSummary?.title ?? outputId;
  const kind = detail?.output.kind ?? initialSummary?.kind ?? null;
  const currentVersion = detail?.output.currentVersion ?? revision ?? null;
  const version = detail?.versions ? latestVersion(detail.versions) : null;
  const threadId = detail?.output.threadId ?? null;
  const busy = actionState !== "idle";
  const exportable =
    detail !== null &&
    (detail.output.status === "saved" || detail.output.status === "signed_off");
  const receiptDigest =
    exportable && version !== null ? version.contentDigest : null;

  // Fetch the server-computed receipt once per exported version, only after the
  // artifact is actually saved/signed off. The card reports pending, signed,
  // unsigned or failed; it never invents a signature or claims "verified".
  useEffect(() => {
    if (receiptDigest === null) {
      setReceiptState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setReceiptState({ phase: "pending" });
    void (async () => {
      try {
        const result = await getJson(
          `/api/studio/outputs/${encodeURIComponent(outputId)}/receipt?digest=${encodeURIComponent(receiptDigest)}`,
        );
        if (cancelled) return;
        if (result.status !== 200) {
          setReceiptState({ phase: "failed" });
          return;
        }
        const parsed = studioOutputReceiptSchema.safeParse(result.body);
        if (
          !parsed.success ||
          parsed.data.outputId !== outputId ||
          parsed.data.payloadSha256 !== receiptDigest
        ) {
          setReceiptState({ phase: "failed" });
          return;
        }
        if (parsed.data.signed && parsed.data.receipt)
          setReceiptState({
            phase: "signed",
            keyId: parsed.data.receipt.keyId,
            signature: parsed.data.receipt.signature,
          });
        else if (!parsed.data.signed && parsed.data.receipt === null)
          setReceiptState({ phase: "unsigned" });
        // A signed/unsigned response whose receipt object disagrees is treated
        // as unreadable rather than displayed as a claim.
        else setReceiptState({ phase: "failed" });
      } catch {
        if (!cancelled) setReceiptState({ phase: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [outputId, receiptDigest]);

  const header = (
    <header className={styles["studio-output-header"]}>
      <div className={styles["studio-output-heading"]}>
        {kind ? (
          <p className={styles["studio-output-kind"]}>
            {OUTPUT_KIND_KEYS[kind]
              ? studioCopy(locale, OUTPUT_KIND_KEYS[kind]!)
              : kind}
          </p>
        ) : null}
        <h4 className={styles["studio-output-title"]}>{title}</h4>
      </div>
      <div className={styles["studio-output-meta"]}>
        {status ? (
          <span className={styles["studio-output-status"]} data-status={status}>
            {studioCopy(locale, STATUS_KEYS[status])}
          </span>
        ) : null}
        {currentVersion !== null ? (
          <span className={styles["studio-output-version"]}>
            {renderStudioLine(locale, {
              key: "studio.outputs.currentVersion",
              values: { version: currentVersion },
            })}
          </span>
        ) : null}
      </div>
    </header>
  );

  const body = (
    <div className={styles["studio-output-body"]}>
      {loading ? (
        <p className={styles["studio-evidence-note"]} role="status">
          {studioCopy(locale, "studio.outputs.loading")}
        </p>
      ) : loadError !== null ? (
        <div className={styles["studio-composer-error"]} role="alert">
          <p>{studioCopy(locale, loadError)}</p>
          <button
            type="button"
            className={styles["studio-composer-retry"]}
            onClick={() => void load()}
          >
            {studioCopy(locale, "studio.error.retry")}
          </button>
        </div>
      ) : detail !== null && version !== null ? (
        <>
          <p className={styles["studio-output-version-meta"]}>
            {renderStudioLine(locale, {
              key: "studio.outputs.revision",
              values: { revision: version.revision },
            })}
            {" · "}
            {formatHkDate(version.asOf, locale)}
            {" · "}
            {renderStudioLine(locale, {
              key: "studio.outputs.digest",
              values: { digest: `${version.contentDigest.slice(0, 12)}…` },
            })}
          </p>

          {detail.output.kind === "copy_proposal" ? (
            <StudioReviewCard
              locale={locale}
              payload={version.payload}
              exportInfo={{
                outputId: detail.output.outputId,
                status: detail.output.status,
                digest: version.contentDigest,
              }}
            />
          ) : detail.output.kind === "finding" ? (
            <StudioFindingCard locale={locale} payload={version.payload} />
          ) : detail.output.kind === "merchant_audit" ? (
            <StudioReportCard
              locale={locale}
              payload={version.payload}
              exportHref={
                detail.output.status === "saved" ||
                detail.output.status === "signed_off"
                  ? `/api/studio/outputs/${encodeURIComponent(outputId)}/export?digest=${version.contentDigest}`
                  : null
              }
              exportReceipt={
                receiptState.phase === "signed"
                  ? {
                      keyId: receiptState.keyId,
                      signature: receiptState.signature,
                    }
                  : receiptState.phase === "unsigned"
                    ? null
                    : undefined
              }
              receiptPending={receiptState.phase === "pending"}
              receiptFailed={receiptState.phase === "failed"}
            />
          ) : (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.outputs.previewUnavailable")}
            </p>
          )}

          {receiptDigest !== null &&
          receiptState.phase !== "idle" &&
          detail.output.kind !== "merchant_audit" ? (
            <section
              className={styles["studio-report-section"]}
              aria-label={studioCopy(locale, "studio.outputs.receiptTitle")}
            >
              <h5 className={styles["studio-evidence-subtitle"]}>
                {studioCopy(locale, "studio.outputs.receiptTitle")}
              </h5>
              {receiptState.phase === "pending" ? (
                <p className={styles["studio-evidence-note"]} role="status">
                  {studioCopy(locale, "studio.outputs.receiptPending")}
                </p>
              ) : receiptState.phase === "failed" ? (
                <p className={styles["studio-evidence-note"]} role="alert">
                  {studioCopy(locale, "studio.outputs.receiptFailed")}
                </p>
              ) : receiptState.phase === "signed" ? (
                <p
                  className={styles["studio-report-line"]}
                  data-export-signed="true"
                  role="status"
                >
                  {renderStudioLine(locale, {
                    key: "studio.outputs.receiptSigned",
                    values: {
                      keyId: receiptState.keyId,
                      signature: receiptState.signature.slice(0, 16),
                    },
                  })}
                </p>
              ) : (
                <p
                  className={styles["studio-report-line"]}
                  data-export-signed="false"
                >
                  {studioCopy(locale, "studio.outputs.receiptUnsigned")}
                </p>
              )}
              <p className={styles["studio-evidence-note"]}>
                {studioCopy(locale, "studio.outputs.receiptHint")}
              </p>
            </section>
          ) : null}

          {notice !== null ? (
            <p className={styles["studio-output-notice"]} role="status">
              {studioCopy(locale, notice)}
            </p>
          ) : null}
          {actionError !== null ? (
            <div className={styles["studio-composer-error"]} role="alert">
              <p>{studioCopy(locale, actionError)}</p>
            </div>
          ) : null}

          <div className={styles["studio-output-actions"]}>
            <button
              type="button"
              className={styles["studio-output-action"]}
              onClick={() => void runAction("save")}
              disabled={busy || detail.output.status !== "draft"}
            >
              {actionState === "saving"
                ? studioCopy(locale, "studio.outputs.saving")
                : studioCopy(locale, "studio.outputs.save")}
            </button>
            <button
              type="button"
              className={styles["studio-output-action"]}
              onClick={() => void runAction("sign_off")}
              disabled={busy || !canSignOff || detail.output.status !== "saved"}
              title={
                !canSignOff
                  ? studioCopy(locale, "studio.outputs.signOffRole")
                  : detail.output.status !== "saved"
                    ? studioCopy(locale, "studio.outputs.signOffNeedsSaved")
                    : undefined
              }
            >
              {actionState === "signing_off"
                ? studioCopy(locale, "studio.outputs.signingOff")
                : studioCopy(locale, "studio.outputs.signOff")}
            </button>
            {threadId ? (
              <Link
                className={styles["studio-evidence-link"]}
                href={`/studio/t/${encodeURIComponent(threadId)}`}
              >
                {studioCopy(locale, "studio.outputs.openThread")}
              </Link>
            ) : null}
          </div>
          {!canSignOff ? (
            <p
              id={`studio-output-signoff-role-${outputId}`}
              className={styles["studio-evidence-note"]}
            >
              {studioCopy(locale, "studio.outputs.signOffRole")}
            </p>
          ) : null}
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.outputs.savedReadback")}
          </p>
        </>
      ) : null}
    </div>
  );

  if (expandable) {
    return (
      <details
        className={styles["studio-output"]}
        data-output-id={outputId}
        data-expandable="true"
        onToggle={handleToggle}
      >
        <summary className={styles["studio-output-summary"]}>
          {header}
          <span className={styles["studio-output-expand-hint"]}>
            {studioCopy(locale, "studio.outputs.viewArtifact")}
          </span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <article
      className={styles["studio-output"]}
      data-output-id={outputId}
      aria-label={studioCopy(locale, "studio.outputs.artifact")}
      aria-busy={loading || busy}
    >
      {header}
      {body}
    </article>
  );
}

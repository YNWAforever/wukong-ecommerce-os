"use client";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { Locale } from "../lib/locale";
import type {
  GuidedAttemptResponse,
  StudioMessageResponse,
} from "../lib/studio/contracts";
import {
  guidedActionSchema,
  guidedScopeSchema,
  type GuidedAction,
} from "../lib/studio/guided-contracts";
import { guidedCopy } from "../lib/studio/guided-copy";
import { turnReplySchema } from "../lib/studio/types";
import styles from "./studio.module.css";
import { StudioOutputCard } from "./studio-output-card";

const detailSchema = z.object({
  output: z.object({
    outputId: z.string(),
    kind: z.string(),
    currentVersion: z.number().int(),
    status: z.string(),
    threadId: z.string().nullable().optional(),
    freshness: z.string().optional(),
    confirmation: z
      .object({
        status: z.string(),
        revision: z.number(),
        contentDigest: z.string(),
      })
      .nullable()
      .optional(),
  }),
  versions: z.array(
    z.object({
      revision: z.number().int(),
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      scope: z.record(z.string(), z.unknown()),
    }),
  ),
});
type Detail = z.infer<typeof detailSchema>;
export function StudioGuidedJourney({
  locale,
  threadId,
  messages,
  attempt,
  canSend,
  canSignOff = false,
  aiEnabled,
  blocked,
  onPrepare,
  onReload,
}: {
  locale: Locale;
  threadId: string;
  messages: readonly StudioMessageResponse[];
  attempt?: GuidedAttemptResponse | null;
  canSend: boolean;
  canSignOff?: boolean;
  aiEnabled: boolean;
  blocked: boolean;
  onPrepare: (action: GuidedAction) => void;
  onReload: () => void;
}) {
  const descriptor = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const operator = messages[i];
      if (operator?.role !== "operator") continue;
      const parsed = guidedActionSchema.safeParse(
        operator.content.guidedAction,
      );
      if (!parsed.success) continue;
      const action = parsed.data;
      let assistant: StudioMessageResponse | undefined;
      for (let j = i + 1; j < messages.length; j++) {
        const item = messages[j];
        if (item?.role === "operator") break;
        if (item?.role === "assistant") {
          assistant = item;
          break;
        }
      }
      const reply = assistant
        ? turnReplySchema.safeParse(assistant.content)
        : null;
      const matchingAttempt =
        attempt?.clientMessageId === operator.clientMessageId ? attempt : null;
      const returned = reply?.success ? reply.data.outputs[0] : undefined;
      const recovered = matchingAttempt?.artifacts?.[0];
      const produced = returned ?? recovered;
      const ref = produced
        ? {
            id: produced.outputId,
            revision: produced.revision,
            digest: returned ? null : (recovered?.contentDigest ?? null),
          }
        : action.kind === "audit"
          ? null
          : {
              id: action.sourceOutputId,
              revision: action.sourceRevision,
              digest: action.sourceDigest,
            };
      const expectedStage = produced
        ? action.kind
        : action.kind === "copy_proposal"
          ? "gap_review"
          : "audit";
      const pending =
        (!produced &&
          matchingAttempt?.status === "failed" &&
          matchingAttempt.reservationState === "settled") ||
        matchingAttempt?.status === "outcome_unknown" ||
        matchingAttempt?.reservationState === "uncertain" ||
        matchingAttempt?.reservationState === "reserved" ||
        (!assistant &&
          (!matchingAttempt ||
            ["queued", "running", "succeeded"].includes(
              matchingAttempt.status,
            ))) ||
        (!produced &&
          action.kind === "copy_proposal" &&
          (!matchingAttempt || matchingAttempt.reservationState === undefined));
      return {
        action,
        ref,
        expectedStage,
        pending,
        produced: Boolean(produced),
        recovered: !returned && Boolean(recovered),
        noResult: !produced,
        clientId: operator.clientMessageId,
      };
    }
    return null;
  }, [messages, attempt]);
  const key = descriptor?.ref
    ? `${descriptor.ref.id}:${descriptor.ref.revision}:${descriptor.ref.digest ?? ""}`
    : "";
  const [loaded, setLoaded] = useState<{ key: string; detail: Detail } | null>(
    null,
  );
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!descriptor?.ref) return;
    const ref = descriptor.ref;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/studio/outputs/${encodeURIComponent(ref.id)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("unavailable");
        const parsed = detailSchema.safeParse(await response.json());
        if (
          !parsed.success ||
          parsed.data.output.outputId !== ref.id ||
          (parsed.data.output.threadId !== undefined &&
            parsed.data.output.threadId !== threadId)
        )
          throw new Error("identity");
        const version = parsed.data.versions.find(
          (item) => item.revision === ref.revision,
        );
        if (
          !version ||
          (ref.digest !== null && version.contentDigest !== ref.digest)
        )
          throw new Error("version");
        if (active) {
          setLoaded({ key, detail: parsed.data });
          setFailedKey(null);
        }
      } catch {
        if (active) {
          setLoaded(null);
          setFailedKey(key);
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, refresh, threadId]);
  if (!descriptor) return null;
  const detail = loaded?.key === key ? loaded.detail : null;
  const version = detail?.versions.find(
    (item) => item.revision === descriptor.ref?.revision,
  );
  const parsedScope = guidedScopeSchema.safeParse(version?.scope.guidedReview);
  const scope =
    parsedScope.success && parsedScope.data.stage === descriptor.expectedStage
      ? parsedScope.data
      : null;
  const expectedKind =
    scope?.stage === "audit"
      ? "merchant_audit"
      : scope?.stage === "gap_review"
        ? "gap_report"
        : "copy_proposal";
  const usable = Boolean(
    scope &&
    detail &&
    detail.output.kind === expectedKind &&
    detail.output.currentVersion === version?.revision &&
    detail.output.freshness === "current" &&
    detail.output.status !== "discarded",
  );
  const next: GuidedAction | null =
    usable &&
    scope &&
    version &&
    descriptor.ref &&
    scope.stage !== "copy_proposal"
      ? {
          kind: scope.stage === "audit" ? "gap_review" : "copy_proposal",
          sourceOutputId: descriptor.ref.id,
          sourceRevision: version.revision,
          sourceDigest: version.contentDigest,
        }
      : null;
  const noVersion =
    scope?.stage === "gap_review" && scope.listing.activeVersionId === null;
  const selectedId =
    scope?.listing.listingId ??
    (descriptor.action.kind === "audit" ? descriptor.action.listingId : null);
  const confirmation = detail?.output.confirmation;
  const saved =
    usable &&
    scope?.stage === "copy_proposal" &&
    ["saved", "signed_off"].includes(detail?.output.status ?? "") &&
    confirmation?.status === detail?.output.status &&
    confirmation?.revision === version?.revision &&
    confirmation?.contentDigest === version?.contentDigest;
  const stages = ["audit", "gap_review", "copy_proposal", "handoff"] as const;
  const completed =
    scope?.stage === "copy_proposal"
      ? saved
        ? 4
        : 3
      : scope?.stage === "gap_review"
        ? 2
        : scope
          ? 1
          : 0;
  return (
    <section
      data-guided-journey="true"
      data-guided-stage={scope?.stage ?? descriptor.action.kind}
      className={styles["studio-report"]}
      aria-label={guidedCopy(locale, "title")}
    >
      <h2>{guidedCopy(locale, "title")}</h2>
      <p>{guidedCopy(locale, "scope")}</p>
      {selectedId ? (
        <a href={`/listings/${encodeURIComponent(selectedId)}`}>
          {guidedCopy(locale, "selected")}
        </a>
      ) : null}
      <ol>
        {stages.map((stage, i) => (
          <li key={stage} data-complete={i < completed ? "true" : "false"}>
            {guidedCopy(locale, stage)}
            {i < completed ? " ✓" : ""}
          </li>
        ))}
      </ol>
      {descriptor.pending ? (
        <p role="status">{guidedCopy(locale, "pending")}</p>
      ) : descriptor.noResult ? (
        <p role="status">{guidedCopy(locale, "unavailable")}</p>
      ) : null}
      {failedKey === key || (detail && !usable) ? (
        <p role="status">{guidedCopy(locale, "stale")}</p>
      ) : null}
      {noVersion ? <p>{guidedCopy(locale, "noVersion")}</p> : null}
      {next?.kind === "copy_proposal" && !aiEnabled ? (
        <p>{guidedCopy(locale, "aiOff")}</p>
      ) : null}
      {blocked ? <p>{guidedCopy(locale, "draft")}</p> : null}
      {next ? (
        <button
          type="button"
          className={styles["studio-secondary-button"]}
          disabled={
            !canSend ||
            blocked ||
            descriptor.pending ||
            noVersion ||
            (next.kind === "copy_proposal" && !aiEnabled)
          }
          onClick={() => onPrepare(next)}
        >
          {guidedCopy(
            locale,
            descriptor.noResult
              ? "prepareAgain"
              : next.kind === "gap_review"
                ? "prepareGap"
                : "prepareCopy",
          )}
        </button>
      ) : null}
      {scope?.stage === "copy_proposal" && usable ? (
        <p>{guidedCopy(locale, saved ? "ready" : "saveHint")}</p>
      ) : null}
      {saved && selectedId && descriptor.ref && version ? (
        <p>
          <a
            className={styles["studio-secondary-button"]}
            href={`/listings/${encodeURIComponent(selectedId)}?studioOutput=${encodeURIComponent(descriptor.ref.id)}&studioRevision=${version.revision}&studioDigest=${version.contentDigest}`}
          >
            {guidedCopy(locale, "review")}
          </a>
        </p>
      ) : null}
      {descriptor.recovered ? (
        <p role="status">{guidedCopy(locale, "recovered")}</p>
      ) : null}
      {descriptor.recovered && descriptor.ref && canSend ? (
        <StudioOutputCard
          locale={locale}
          outputId={descriptor.ref.id}
          revision={descriptor.ref.revision}
          canSignOff={canSignOff}
        />
      ) : null}
      {descriptor.recovered || descriptor.pending ? (
        <p>
          <a href="/studio/outputs">{guidedCopy(locale, "artifacts")}</a>
        </p>
      ) : null}
      <p>{guidedCopy(locale, "sendHint")}</p>
      <button
        type="button"
        className={styles["studio-secondary-button"]}
        onClick={() => {
          setRefresh((value) => value + 1);
          onReload();
        }}
      >
        {guidedCopy(locale, "refresh")}
      </button>
    </section>
  );
}

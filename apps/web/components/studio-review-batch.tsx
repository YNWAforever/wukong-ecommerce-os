"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import {
  STUDIO_REVIEW_BATCH_LIMIT,
  type StudioListingReviewState,
  type StudioReviewArtifact,
  type StudioReviewBatchResult,
  type StudioReviewCandidate,
  type StudioReviewFailureCode,
} from "../lib/studio/review-batch";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * Bounded multi-listing review surface (2026-11-16 plan, PR 2).
 *
 * Selection is explicit and capped; the single Start review button posts the
 * whole selection, and the server runs the deterministic stages sequentially
 * per listing. Nothing is fetched or submitted on mount beyond the server
 * page's own read, no request is retried in the background, and the results
 * always link to the exact recorded revision/digest. A failed listing is shown
 * with its bounded reason instead of being folded into another listing's
 * outcome, and the operator can reselect just the failures to retry.
 */

const OUTCOME_KEYS = {
  complete: "studio.reviews.outcome.complete",
  partial: "studio.reviews.outcome.partial",
  failed: "studio.reviews.outcome.failed",
  recorded: "studio.reviews.outcome.recorded",
} as const satisfies Record<string, StudioCopyKey>;

const FAILURE_KEYS = {
  listing_unavailable: "studio.reviews.failure.listing_unavailable",
  listing_changed: "studio.reviews.failure.listing_changed",
  review_unavailable: "studio.reviews.failure.review_unavailable",
  review_failed: "studio.reviews.failure.review_failed",
} as const satisfies Record<StudioReviewFailureCode, StudioCopyKey>;

export type StudioReviewResultItem = {
  listingId: string;
  title: string;
  outcome: "complete" | "partial" | "failed" | "recorded";
  failureCode: StudioReviewFailureCode | null;
  threadId: string | null;
  audit: StudioReviewArtifact | null;
  gap: StudioReviewArtifact | null;
};

function recordedResults(
  reconstruction: readonly StudioListingReviewState[],
): StudioReviewResultItem[] {
  return reconstruction
    .filter((item) => item.audit !== null || item.gap !== null)
    .map((item) => ({
      listingId: item.listingId,
      title: item.title,
      outcome: "recorded" as const,
      failureCode: null,
      threadId: item.threadId,
      audit: item.audit,
      gap: item.gap,
    }));
}

function artifactHref(artifact: StudioReviewArtifact): string {
  const query = new URLSearchParams({
    revision: String(artifact.revision),
    digest: artifact.contentDigest,
  });
  return `/studio/outputs/${artifact.outputId}?${query.toString()}`;
}

function buildHref(input: {
  q: string;
  page: number;
  listingIds?: readonly string[];
}): string {
  const query = new URLSearchParams();
  if (input.q) query.set("q", input.q);
  if (input.page > 1) query.set("page", String(input.page));
  if (input.listingIds && input.listingIds.length > 0)
    query.set("listingIds", input.listingIds.join(","));
  const suffix = query.toString();
  return suffix ? `/studio/reviews?${suffix}` : "/studio/reviews";
}

export type StudioReviewBatchProps = {
  readonly locale: Locale;
  readonly canOperate: boolean;
  readonly candidates: readonly StudioReviewCandidate[];
  readonly query: { readonly q: string; readonly page: number };
  readonly totalMatching: number;
  readonly hasNext: boolean;
  readonly reconstruction: readonly StudioListingReviewState[];
};

export function StudioReviewBatch({
  locale,
  canOperate,
  candidates,
  query,
  totalMatching,
  hasNext,
  reconstruction,
}: StudioReviewBatchProps) {
  const router = useRouter();
  const copy = (key: StudioCopyKey) => studioCopy(locale, key);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StudioCopyKey | null>(null);
  const [notice, setNotice] = useState<StudioCopyKey | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [results, setResults] = useState<StudioReviewResultItem[]>(() =>
    recordedResults(reconstruction),
  );

  const candidateById = useMemo(() => {
    const map = new Map<string, StudioReviewCandidate>();
    for (const candidate of candidates) map.set(candidate.listingId, candidate);
    return map;
  }, [candidates]);

  function toggle(listingId: string) {
    setError(null);
    setSelected((current) => {
      if (current.includes(listingId)) {
        setLimitReached(false);
        return current.filter((id) => id !== listingId);
      }
      if (current.length >= STUDIO_REVIEW_BATCH_LIMIT) {
        setLimitReached(true);
        return current;
      }
      setLimitReached(false);
      return [...current, listingId];
    });
  }

  function selectFailed() {
    setError(null);
    const failed = results
      .filter((item) => item.outcome === "failed")
      .map((item) => item.listingId)
      .slice(0, STUDIO_REVIEW_BATCH_LIMIT);
    setSelected(failed);
    setLimitReached(false);
  }

  async function start() {
    if (busy || !canOperate) return;
    if (selected.length === 0) {
      setError("studio.reviews.noSelection");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/studio/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingIds: selected, locale }),
      });
      if (!response.ok) {
        setError("studio.reviews.requestFailed");
        return;
      }
      const body = (await response.json()) as StudioReviewBatchResult;
      setResults(
        body.items.map((item) => ({
          listingId: item.listingId,
          title: item.title,
          outcome: item.outcome,
          failureCode: item.failureCode,
          threadId: item.threadId,
          audit: item.audit,
          gap: item.gap,
        })),
      );
      setNotice("studio.reviews.completed");
      // Persist the request scope in the URL so a reload rebuilds the same
      // recorded state from the database instead of client memory.
      router.replace(
        buildHref({ q: query.q, page: query.page, listingIds: selected }),
        { scroll: false },
      );
    } catch {
      setError("studio.reviews.requestFailed");
    } finally {
      setBusy(false);
    }
  }

  const failedCount = results.filter(
    (item) => item.outcome === "failed",
  ).length;

  return (
    <div className={styles["studio-review-batch"]}>
      <p className={styles["studio-notice"]}>{copy("studio.reviews.rule")}</p>

      <section
        className={styles["studio-report"]}
        aria-label={copy("studio.reviews.selectTitle")}
      >
        <header className={styles["studio-report-header"]}>
          <h2 className={styles["studio-report-title"]}>
            {copy("studio.reviews.selectTitle")}
          </h2>
          <span className={styles["studio-review-counter"]}>
            {renderStudioLine(locale, {
              key: "studio.reviews.selectHint",
              values: {
                count: selected.length,
                limit: STUDIO_REVIEW_BATCH_LIMIT,
              },
            })}
          </span>
        </header>

        <form
          className={styles["studio-review-search"]}
          action="/studio/reviews"
          method="get"
          role="search"
        >
          <label htmlFor="studio-review-search-input">
            {copy("studio.reviews.searchLabel")}
          </label>
          <input
            id="studio-review-search-input"
            className={styles["studio-review-search-input"]}
            name="q"
            type="search"
            defaultValue={query.q}
            placeholder={copy("studio.reviews.searchPlaceholder")}
            maxLength={120}
          />
          <button type="submit" className={styles["studio-review-search-go"]}>
            {copy("studio.reviews.search")}
          </button>
        </form>

        <p className={styles["studio-evidence-note"]}>
          {renderStudioLine(locale, {
            key: "studio.reviews.total",
            values: { count: totalMatching },
          })}
          {" · "}
          {renderStudioLine(locale, {
            key: "studio.reviews.page",
            values: { page: query.page },
          })}
        </p>

        {candidates.length === 0 ? (
          <p className={styles["studio-evidence-note"]}>
            {copy("studio.reviews.empty")}
          </p>
        ) : (
          <fieldset className={styles["studio-review-fieldset"]}>
            <legend>{copy("studio.reviews.selectTitle")}</legend>
            <ul className={styles["studio-review-list"]}>
              {candidates.map((candidate) => {
                const checked = selected.includes(candidate.listingId);
                const disabled =
                  busy ||
                  !canOperate ||
                  (!checked && selected.length >= STUDIO_REVIEW_BATCH_LIMIT);
                const title =
                  candidate.title.length > 0
                    ? candidate.title
                    : candidate.listingId.slice(0, 8);
                return (
                  <li
                    key={candidate.listingId}
                    className={styles["studio-review-candidate"]}
                    data-listing-id={candidate.listingId}
                    data-selected={checked ? "true" : "false"}
                  >
                    <label className={styles["studio-review-candidate-label"]}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggle(candidate.listingId)}
                        aria-label={title}
                      />
                      <span className={styles["studio-review-candidate-title"]}>
                        {title}
                      </span>
                    </label>
                    <span className={styles["studio-review-candidate-meta"]}>
                      {candidate.status}
                      {" · "}
                      {candidate.activeVersion
                        ? `v${candidate.activeVersion.sequence}`
                        : copy("studio.reviews.noActiveVersion")}
                      {candidate.blockingFlagCount > 0
                        ? ` · ${renderStudioLine(locale, {
                            key: "studio.reviews.blockingFlags",
                            values: { count: candidate.blockingFlagCount },
                          })}`
                        : ""}
                    </span>
                    <span className={styles["studio-review-candidate-links"]}>
                      <span>{copy("studio.reviews.latest")}:</span>
                      {candidate.audit ? (
                        <Link
                          prefetch={false}
                          className={styles["studio-evidence-link"]}
                          href={artifactHref(candidate.audit)}
                        >
                          {copy("studio.reviews.openAudit")}
                        </Link>
                      ) : (
                        <span>{copy("studio.reviews.notRecorded")}</span>
                      )}
                      {candidate.gap ? (
                        <Link
                          prefetch={false}
                          className={styles["studio-evidence-link"]}
                          href={artifactHref(candidate.gap)}
                        >
                          {copy("studio.reviews.openGap")}
                        </Link>
                      ) : null}
                      {candidate.threadId ? (
                        <Link
                          className={styles["studio-evidence-link"]}
                          href={`/studio/t/${candidate.threadId}`}
                        >
                          {copy("studio.reviews.openThread")}
                        </Link>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        {totalMatching > 0 ? (
          <nav
            className={styles["studio-pagination"]}
            aria-label={renderStudioLine(locale, {
              key: "studio.reviews.page",
              values: { page: query.page },
            })}
          >
            {query.page > 1 ? (
              <Link href={buildHref({ q: query.q, page: query.page - 1 })}>
                {copy("studio.reviews.previous")}
              </Link>
            ) : null}
            {hasNext ? (
              <Link href={buildHref({ q: query.q, page: query.page + 1 })}>
                {copy("studio.reviews.next")}
              </Link>
            ) : null}
          </nav>
        ) : null}

        {limitReached ? (
          <p className={styles["studio-evidence-note"]} role="alert">
            {renderStudioLine(locale, {
              key: "studio.reviews.capReached",
              values: { limit: STUDIO_REVIEW_BATCH_LIMIT },
            })}
          </p>
        ) : null}
        {!canOperate ? (
          <p className={styles["studio-evidence-note"]}>
            {copy("studio.reviews.notOperator")}
          </p>
        ) : null}

        <div className={styles["studio-review-actions"]}>
          <button
            type="button"
            className={styles["studio-review-start"]}
            onClick={() => void start()}
            disabled={busy || !canOperate || selected.length === 0}
          >
            {busy
              ? copy("studio.reviews.starting")
              : copy("studio.reviews.start")}
          </button>
          {failedCount > 0 && canOperate && !busy ? (
            <button
              type="button"
              className={styles["studio-review-secondary"]}
              onClick={selectFailed}
            >
              {copy("studio.reviews.selectFailed")}
            </button>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className={styles["studio-notice"]} data-tone="error">
            {copy(error)}
          </p>
        ) : null}
        <p
          role="status"
          aria-live="polite"
          className={styles["studio-evidence-note"]}
        >
          {busy ? copy("studio.reviews.starting") : notice ? copy(notice) : ""}
        </p>
      </section>

      <section
        className={styles["studio-report"]}
        aria-label={copy("studio.reviews.resultsTitle")}
      >
        <header className={styles["studio-report-header"]}>
          <h2 className={styles["studio-report-title"]}>
            {copy("studio.reviews.resultsTitle")}
          </h2>
          <p className={styles["studio-evidence-note"]}>
            {copy("studio.reviews.resultsHint")}
          </p>
        </header>
        {results.length === 0 ? (
          <p className={styles["studio-evidence-note"]}>
            {copy("studio.reviews.resultsEmpty")}
          </p>
        ) : (
          <ul
            className={styles["studio-review-results"]}
            aria-label={copy("studio.reviews.resultsTitle")}
          >
            {results.map((item) => {
              const candidate = candidateById.get(item.listingId);
              const title =
                item.title.length > 0
                  ? item.title
                  : (candidate?.title ?? item.listingId.slice(0, 8));
              return (
                <li
                  key={item.listingId}
                  className={styles["studio-review-result"]}
                  data-listing-id={item.listingId}
                  data-review-result="true"
                  data-outcome={item.outcome}
                >
                  <div className={styles["studio-review-result-head"]}>
                    <strong>{title}</strong>
                    <span
                      className={styles["studio-review-outcome"]}
                      data-outcome={item.outcome}
                    >
                      {copy(OUTCOME_KEYS[item.outcome])}
                    </span>
                  </div>
                  {item.failureCode ? (
                    <p className={styles["studio-review-failure"]}>
                      {copy(FAILURE_KEYS[item.failureCode])}
                    </p>
                  ) : null}
                  <div className={styles["studio-review-result-links"]}>
                    {item.threadId ? (
                      <Link
                        className={styles["studio-evidence-link"]}
                        href={`/studio/t/${item.threadId}`}
                      >
                        {copy("studio.reviews.openThread")}
                      </Link>
                    ) : null}
                    {item.audit ? (
                      <Link
                        prefetch={false}
                        className={styles["studio-evidence-link"]}
                        href={artifactHref(item.audit)}
                      >
                        {copy("studio.reviews.openAudit")}
                      </Link>
                    ) : null}
                    {item.gap ? (
                      <Link
                        prefetch={false}
                        className={styles["studio-evidence-link"]}
                        href={artifactHref(item.gap)}
                      >
                        {copy("studio.reviews.openGap")}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

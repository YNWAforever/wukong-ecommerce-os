import Link from "next/link";
import { cookies } from "next/headers";

import { StudioReviewBatch } from "../../../../components/studio-review-batch";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type {
  StudioListingReviewState,
  StudioReviewCandidatesResult,
} from "../../../../lib/studio/review-batch";
import { studioCopy } from "../../../../lib/studio-copy";
import styles from "../../../../components/studio.module.css";
import { studioService } from "../studio-service";

/**
 * `/studio/reviews` — bounded multi-listing review (2026-11-16 plan, PR 2).
 *
 * The server read is selection data only: one bounded page of recent listings
 * plus the newest recorded review links, and — when the URL names listings —
 * the recorded state for those listings. Rendering this page starts nothing;
 * the single Start review action is the operator's explicit request.
 */

function failureNotice(
  locale: Parameters<typeof studioCopy>[0],
  messageKey:
    | "studio.reviews.listUnavailable"
    | "studio.reviews.reconstructionUnavailable",
) {
  return (
    <p role="alert" className={styles["studio-notice"]} data-tone="error">
      {studioCopy(locale, messageKey)}
    </p>
  );
}

export default async function StudioReviewsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{
    q?: string | string[];
    page?: string | string[];
    listingIds?: string | string[];
  }>;
}>) {
  const params = await searchParams;
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const session = await authSessionContext.resolve();
  const canOperate = requireWorkspaceRole(
    "operator",
    session?.role ?? "viewer",
  );

  let candidates: StudioReviewCandidatesResult | null = null;
  try {
    candidates = await studioService().reviewCandidates({
      q: single(params.q) ?? "",
      page: single(params.page) ?? "1",
    });
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "studio_review_candidates_read_failed",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }

  let reconstruction: StudioListingReviewState[] = [];
  let reconstructionFailed = false;
  const listingIds = single(params.listingIds);
  if (listingIds) {
    try {
      reconstruction = (await studioService().listingReviews({ listingIds }))
        .items;
    } catch {
      reconstructionFailed = true;
    }
  }

  return (
    <div className={styles["studio-section"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.home.eyebrow")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.reviews.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.reviews.lede")}
        </p>
        <p className={styles["studio-section-lede"]}>
          <Link href="/studio/inbox">
            {studioCopy(locale, "studio.rail.inbox")}
          </Link>
          {" · "}
          <Link href="/studio/threads">
            {studioCopy(locale, "studio.rail.conversations")}
          </Link>
          {" · "}
          <Link href="/studio/outputs">
            {studioCopy(locale, "studio.rail.outputs")}
          </Link>
        </p>
      </header>

      {reconstructionFailed
        ? failureNotice(locale, "studio.reviews.reconstructionUnavailable")
        : null}

      {candidates === null ? (
        failureNotice(locale, "studio.reviews.listUnavailable")
      ) : (
        <StudioReviewBatch
          locale={locale}
          canOperate={canOperate}
          candidates={candidates.items}
          query={{ q: candidates.q, page: candidates.page }}
          totalMatching={candidates.totalMatching}
          hasNext={candidates.hasNext}
          reconstruction={reconstruction}
        />
      )}
    </div>
  );
}

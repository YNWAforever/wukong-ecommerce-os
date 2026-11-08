import Link from "next/link";

import type { StudioOverviewResult } from "../lib/studio/contracts";
import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import { formatHkDate, stateLabel } from "../lib/ui-copy";
import styles from "./studio.module.css";

/**
 * The deterministic conversation-home overview strip (design spec §2.2).
 *
 * Every number here comes from `GET /api/studio/overview` (or the same server
 * service method): canonical workspace records only, no model call and no
 * estimation. The exact rule — "From workspace records; no AI call." — is
 * printed next to the tiles and pinned by the copy test.
 *
 * Tiles for reads this build does not implement (open blocking flags,
 * unapproved drafts, last import, last export) say "Not yet available" and
 * never render a guessed number. A failed overview read shows the honest
 * failure line, not zeroes.
 */

type OverviewTile = {
  readonly key: string;
  readonly labelKey: StudioCopyKey;
  readonly available: boolean;
  readonly value?: string;
  readonly detail?: string;
  readonly deepLink?: string;
  readonly linkLabelKey?: StudioCopyKey;
};

const UNAVAILABLE_TILES: readonly {
  labelKey: StudioCopyKey;
  key: string;
}[] = [
  { key: "open-blocking-flags", labelKey: "studio.overview.openBlockingFlags" },
  { key: "unapproved-drafts", labelKey: "studio.overview.unapprovedDrafts" },
  { key: "last-import", labelKey: "studio.overview.lastImport" },
  { key: "last-export", labelKey: "studio.overview.lastExport" },
];

const PROJECTION_KEYS = {
  ready: "studio.overview.projectionReady",
  pending: "studio.overview.projectionPending",
  failed: "studio.overview.projectionFailed",
} as const satisfies Record<string, StudioCopyKey>;

function ListingTile(
  locale: Locale,
  overview: StudioOverviewResult,
): OverviewTile {
  const byStatus = Object.entries(overview.listingCounts.byStatus).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const statuses = byStatus
    .map(([status, count]) => `${stateLabel(status, locale)} ${count}`)
    .join(" · ");
  return {
    key: "listings",
    labelKey: "studio.overview.totalListings",
    available: true,
    value: renderStudioLine(locale, {
      key: "studio.overview.totalCount",
      values: { count: overview.listingCounts.total },
    }),
    ...(statuses.length > 0
      ? {
          detail: renderStudioLine(locale, {
            key: "studio.overview.byStatus",
            values: { statuses },
          }),
        }
      : { detail: studioCopy(locale, "studio.overview.noListings") }),
    deepLink: overview.listingCounts.deepLink,
    linkLabelKey: "studio.overview.open",
  };
}

function QualityTiles(
  locale: Locale,
  overview: StudioOverviewResult,
): OverviewTile[] {
  const quality = overview.quality;
  const projectionKey =
    PROJECTION_KEYS[quality.projectionState] ?? PROJECTION_KEYS.ready;
  const detail = [
    renderStudioLine(locale, {
      key: "studio.overview.qualityAssessed",
      values: {
        totalAssessed: quality.totalAssessed,
        totalListings: quality.totalListings,
      },
    }),
    renderStudioLine(locale, {
      key: "studio.overview.qualityClean",
      values: { count: quality.cleanCount },
    }),
    renderStudioLine(locale, {
      key: "studio.overview.qualityGapCount",
      values: { count: quality.hasGapsCount },
    }),
    studioCopy(locale, projectionKey),
  ];
  if (quality.asOf) {
    detail.push(
      renderStudioLine(locale, {
        key: "studio.overview.asOf",
        values: { asOf: formatHkDate(quality.asOf, locale) },
      }),
    );
  }
  return [
    {
      key: "quality",
      labelKey: "studio.overview.qualityGaps",
      available: true,
      value: renderStudioLine(locale, {
        key: "studio.overview.qualityGapCount",
        values: { count: quality.hasGapsCount },
      }),
      detail: detail.join(" · "),
      deepLink: quality.deepLink,
      linkLabelKey: "studio.overview.open",
    },
  ];
}

function FailedJobsTile(
  locale: Locale,
  overview: StudioOverviewResult,
): OverviewTile {
  const items = overview.recentJobs.items;
  const failed = items.filter((item) => item.state === "failed").length;
  return {
    key: "failed-jobs",
    labelKey: "studio.overview.failedJobs",
    available: true,
    value: String(failed),
    detail:
      items.length === 0
        ? studioCopy(locale, "studio.overview.recentJobsEmpty")
        : renderStudioLine(locale, {
            key: "studio.overview.failedWithinRecent",
            values: { failed, count: items.length },
          }),
    deepLink: overview.recentJobs.deepLink,
    linkLabelKey: "studio.overview.open",
  };
}

export type StudioHomeOverviewProps = {
  readonly locale: Locale;
  /** `null` means the overview read failed closed. */
  readonly overview: StudioOverviewResult | null;
};

export function StudioHomeOverview({
  locale,
  overview,
}: StudioHomeOverviewProps) {
  const tiles: OverviewTile[] =
    overview === null
      ? UNAVAILABLE_TILES.map((tile) => ({
          key: tile.key,
          labelKey: tile.labelKey,
          available: false,
        }))
      : [
          ListingTile(locale, overview),
          ...QualityTiles(locale, overview),
          FailedJobsTile(locale, overview),
          ...UNAVAILABLE_TILES.map((tile) => ({
            key: tile.key,
            labelKey: tile.labelKey,
            available: false,
          })),
        ];

  return (
    <section
      className={styles["studio-section"]}
      aria-label={studioCopy(locale, "studio.overview.title")}
    >
      <div className={styles["studio-section-header"]}>
        <h2 className={styles["studio-section-title"]}>
          {studioCopy(locale, "studio.overview.title")}
        </h2>
        {/* The spec's exact rule for this strip: records only, no model. */}
        <p className={styles["studio-section-lede"]}>
          {studioCopy(locale, "studio.overview.rule")}
        </p>
      </div>

      {overview === null ? (
        <p className={styles["studio-notice"]}>
          {studioCopy(locale, "studio.overview.loadFailed")}
        </p>
      ) : null}

      <ul className={styles["studio-overview-grid"]}>
        {tiles.map((tile) => (
          <li
            key={tile.key}
            className={styles["studio-overview-tile"]}
            data-available={tile.available ? "true" : "false"}
          >
            <span className={styles["studio-overview-label"]}>
              {studioCopy(locale, tile.labelKey)}
            </span>
            <span className={styles["studio-overview-value"]}>
              {tile.available && tile.value !== undefined
                ? tile.value
                : studioCopy(locale, "studio.overview.notYetAvailable")}
            </span>
            {tile.available ? (
              tile.detail ? (
                <span className={styles["studio-overview-detail"]}>
                  {tile.detail}
                </span>
              ) : null
            ) : (
              <span className={styles["studio-overview-detail"]}>
                {studioCopy(locale, "studio.overview.unavailableTile")}
              </span>
            )}
            {tile.available && tile.deepLink && tile.linkLabelKey ? (
              <Link
                className={styles["studio-overview-link"]}
                href={tile.deepLink}
              >
                {studioCopy(locale, tile.linkLabelKey)}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

import Link from "next/link";
import { cookies } from "next/headers";

import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { renderStudioLine } from "../../../../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../../../../lib/studio-copy";
import type {
  StudioInboxAttentionItem,
  StudioInboxResult,
} from "../../../../lib/studio/contracts";
import { formatHkDate } from "../../../../lib/ui-copy";
import styles from "../../../../components/studio.module.css";
import { studioService } from "../studio-service";

/**
 * `/studio/inbox` — the read-only orchestration inbox (P3.1).
 *
 * The aggregate is built by `buildStudioInbox` from one workspace-scoped read
 * of records the existing screens already own: quality gaps/versions from the
 * quality projection, non-success pipeline jobs, draft/saved Studio artifacts
 * and recent conversations. Nothing here writes, publishes or calls a model;
 * each bounded section states when it is truncated, an unreadable source is
 * marked unavailable (never zero) and a failed read collapses to one honest
 * failure line with a content-free log.
 */

const ATTENTION_KEYS: Readonly<
  Record<StudioInboxAttentionItem["key"], StudioCopyKey>
> = {
  listings_with_gaps: "studio.inbox.attention.hasGaps",
  listings_without_active_version:
    "studio.inbox.attention.withoutActiveVersion",
  unassessable_active_version: "studio.inbox.attention.unassessableVersion",
  listings_awaiting_review: "studio.inbox.attention.awaitingReview",
};

function SectionHeader({
  locale,
  titleKey,
  href,
  linkKey,
}: {
  readonly locale: Parameters<typeof studioCopy>[0];
  readonly titleKey: StudioCopyKey;
  readonly href: string;
  readonly linkKey: StudioCopyKey;
}) {
  return (
    <header className={styles["studio-report-header"]}>
      <h2 className={styles["studio-report-title"]}>
        {studioCopy(locale, titleKey)}
      </h2>
      <Link className={styles["studio-evidence-link"]} href={href}>
        {studioCopy(locale, linkKey)}
      </Link>
    </header>
  );
}

function TruncatedNotice({
  locale,
  truncated,
}: {
  readonly locale: Parameters<typeof studioCopy>[0];
  readonly truncated: boolean;
}) {
  return truncated ? (
    <p className={styles["studio-notice"]}>
      {studioCopy(locale, "studio.inbox.truncated")}
    </p>
  ) : null;
}

export default async function StudioInboxPage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  let inbox: StudioInboxResult;
  try {
    inbox = await studioService().inbox();
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "studio_inbox_read_failed",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return (
      <div className={styles["studio-section"]}>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.inbox.title")}
        </h1>
        <p className={styles["studio-notice"]} role="alert">
          {studioCopy(locale, "studio.inbox.failure")}
        </p>
      </div>
    );
  }

  const attentionWithCounts = inbox.needsAttention.items.some(
    (item) => item.count !== null && item.count > 0,
  );

  return (
    <div className={styles["studio-section"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.rail.inbox")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.inbox.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.inbox.lede")}
        </p>
        <p className={styles["studio-section-lede"]}>
          {renderStudioLine(locale, {
            key: "studio.inbox.asOf",
            values: { asOf: formatHkDate(inbox.asOf, locale) },
          })}
          {" · "}
          {studioCopy(locale, "studio.inbox.rule")}
        </p>
      </header>

      <div className={styles["studio-inbox-grid"]}>
        <section
          className={styles["studio-report"]}
          aria-label={studioCopy(locale, "studio.inbox.attentionTitle")}
        >
          <SectionHeader
            locale={locale}
            titleKey="studio.inbox.attentionTitle"
            href={inbox.needsAttention.deepLink}
            linkKey="studio.inbox.attention.openQuality"
          />
          {inbox.needsAttention.unavailable ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.unavailable")}
            </p>
          ) : attentionWithCounts ? (
            <ul className={styles["studio-turn-list"]}>
              {inbox.needsAttention.items.map((item) => (
                <li key={item.key}>
                  {item.count === null
                    ? studioCopy(locale, "studio.inbox.unavailable")
                    : renderStudioLine(locale, {
                        key: ATTENTION_KEYS[item.key],
                        values: { count: item.count },
                      })}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.attention.allClear")}
            </p>
          )}
        </section>

        <section
          className={styles["studio-report"]}
          aria-label={studioCopy(locale, "studio.inbox.jobsTitle")}
        >
          <SectionHeader
            locale={locale}
            titleKey="studio.inbox.jobsTitle"
            href={inbox.jobs.deepLink}
            linkKey="studio.inbox.jobs.open"
          />
          {inbox.jobs.unavailable ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.unavailable")}
            </p>
          ) : inbox.jobs.items.length === 0 ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.jobs.empty")}
            </p>
          ) : (
            <ul className={styles["studio-turn-list"]}>
              {inbox.jobs.items.map((job) => (
                <li key={job.jobId} className={styles["studio-inbox-item"]}>
                  <Link
                    className={styles["studio-evidence-link"]}
                    href={job.deepLink}
                  >
                    {job.jobId}
                  </Link>
                  <span className={styles["studio-inbox-item-meta"]}>
                    {renderStudioLine(locale, {
                      key: "studio.inbox.jobs.state",
                      values: { state: job.state },
                    })}{" "}
                    · {formatHkDate(job.createdAt, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <TruncatedNotice locale={locale} truncated={inbox.jobs.truncated} />
        </section>

        <section
          className={styles["studio-report"]}
          aria-label={studioCopy(locale, "studio.inbox.outputsTitle")}
        >
          <SectionHeader
            locale={locale}
            titleKey="studio.inbox.outputsTitle"
            href={inbox.outputs.deepLink}
            linkKey="studio.inbox.outputs.open"
          />
          {inbox.outputs.unavailable ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.unavailable")}
            </p>
          ) : inbox.outputs.items.length === 0 ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.outputs.empty")}
            </p>
          ) : (
            <ul className={styles["studio-turn-list"]}>
              {inbox.outputs.items.map((output) => (
                <li
                  key={output.outputId}
                  className={styles["studio-inbox-item"]}
                >
                  <Link
                    className={styles["studio-evidence-link"]}
                    href={output.deepLink}
                  >
                    {output.title}
                  </Link>
                  <span className={styles["studio-inbox-item-meta"]}>
                    {output.kind} ·{" "}
                    {studioCopy(
                      locale,
                      output.status === "draft"
                        ? "studio.inbox.outputs.draft"
                        : "studio.inbox.outputs.saved",
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <TruncatedNotice
            locale={locale}
            truncated={inbox.outputs.truncated}
          />
        </section>

        <section
          className={styles["studio-report"]}
          aria-label={studioCopy(locale, "studio.inbox.conversationsTitle")}
        >
          <SectionHeader
            locale={locale}
            titleKey="studio.inbox.conversationsTitle"
            href={inbox.conversations.deepLink}
            linkKey="studio.inbox.conversations.open"
          />
          {inbox.conversations.unavailable ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.unavailable")}
            </p>
          ) : inbox.conversations.items.length === 0 ? (
            <p className={styles["studio-evidence-note"]}>
              {studioCopy(locale, "studio.inbox.conversations.empty")}
            </p>
          ) : (
            <ul className={styles["studio-turn-list"]}>
              {inbox.conversations.items.map((thread) => (
                <li
                  key={thread.threadId}
                  className={styles["studio-inbox-item"]}
                >
                  <Link
                    className={styles["studio-evidence-link"]}
                    href={thread.deepLink}
                  >
                    {thread.title}
                  </Link>
                  <span className={styles["studio-inbox-item-meta"]}>
                    {formatHkDate(thread.updatedAt, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <TruncatedNotice
            locale={locale}
            truncated={inbox.conversations.truncated}
          />
        </section>
      </div>
    </div>
  );
}

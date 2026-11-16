import Link from "next/link";

import type { Locale } from "../lib/locale";
import type { StudioInboxResult } from "../lib/studio/contracts";
import { buildStudioAttentionQueue } from "../lib/studio/attention";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The "Today" work queue (P1).
 *
 * One prioritised list over the same read-only inbox aggregate the Inbox page
 * uses: listings waiting for review, quality gaps, incomplete versions,
 * pipeline jobs, drafts, saved work awaiting sign-off and recent conversations.
 * Every row has exactly one link and states the role that owns the decision, so
 * a first-time operator can answer "what do I do now?" without cross-referencing
 * four screens.
 *
 * The component renders on the server. It never writes, never calls a model,
 * and a failed aggregate read says so instead of showing an empty queue.
 */

const OWNER_KEYS = {
  operator: "studio.today.owner.operator",
  reviewer: "studio.today.owner.reviewer",
  admin: "studio.today.owner.admin",
} as const satisfies Record<string, StudioCopyKey>;

const HOW_STEPS: readonly StudioCopyKey[] = [
  "studio.today.howStep1",
  "studio.today.howStep2",
  "studio.today.howStep3",
];

export function StudioToday({
  locale,
  inbox,
  limit = 6,
  titleKey = "studio.today.title",
  ledeKey = "studio.today.lede",
  showHowTo = false,
  showSourceNotes = false,
}: {
  readonly locale: Locale;
  readonly inbox: StudioInboxResult | null;
  readonly limit?: number;
  readonly titleKey?: StudioCopyKey;
  readonly ledeKey?: StudioCopyKey;
  readonly showHowTo?: boolean;
  /** Show the "bounded list" note; the Inbox is the place that claims completeness. */
  readonly showSourceNotes?: boolean;
}) {
  const queue = inbox === null ? null : buildStudioAttentionQueue(inbox);
  const visible = queue === null ? [] : queue.items.slice(0, limit);
  const remaining = queue === null ? 0 : queue.total - visible.length;
  const title = studioCopy(locale, titleKey);

  return (
    <section className={styles["studio-today"]} aria-label={title}>
      <header className={styles["studio-today-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.today.queueLabel")}
        </p>
        <h2 className={styles["studio-today-title"]}>{title}</h2>
        <p className={styles["studio-today-lede"]}>
          {studioCopy(locale, ledeKey)}
        </p>
      </header>

      {queue === null || queue.unavailable ? (
        <p className={styles["studio-notice"]} role="status">
          {studioCopy(locale, "studio.today.unavailable")}
        </p>
      ) : visible.length === 0 ? (
        <p className={styles["studio-today-empty"]}>
          {studioCopy(locale, "studio.today.allClear")}
        </p>
      ) : (
        <ul className={styles["studio-today-list"]}>
          {visible.map((entry) => (
            <li
              key={entry.id}
              className={styles["studio-today-item"]}
              data-kind={entry.kind}
            >
              <span
                className={styles["studio-today-owner"]}
                data-owner={entry.owner}
              >
                {studioCopy(locale, OWNER_KEYS[entry.owner])}
              </span>
              <span className={styles["studio-today-line"]}>
                {renderStudioLine(locale, entry.line)}
              </span>
              <Link className={styles["studio-today-action"]} href={entry.href}>
                {studioCopy(locale, entry.actionKey)}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 ? (
        <p className={styles["studio-today-more"]}>
          <Link href="/studio/inbox">
            {renderStudioLine(locale, {
              key: "studio.today.more",
              values: { count: remaining },
            })}
          </Link>
        </p>
      ) : null}

      {showSourceNotes &&
      queue !== null &&
      !queue.unavailable &&
      queue.incomplete ? (
        <p className={styles["studio-today-partial"]}>
          {studioCopy(locale, "studio.today.partial")}
        </p>
      ) : null}

      {showSourceNotes &&
      queue !== null &&
      !queue.unavailable &&
      queue.truncated ? (
        <p className={styles["studio-today-partial"]}>
          {studioCopy(locale, "studio.today.truncated")}
        </p>
      ) : null}

      {showHowTo ? (
        <section
          className={styles["studio-how"]}
          aria-label={studioCopy(locale, "studio.today.howTitle")}
        >
          <h3 className={styles["studio-how-title"]}>
            {studioCopy(locale, "studio.today.howTitle")}
          </h3>
          <ol className={styles["studio-how-list"]}>
            {HOW_STEPS.map((key) => (
              <li key={key}>{studioCopy(locale, key)}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}

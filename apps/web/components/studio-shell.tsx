"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import { formatHkDate } from "../lib/ui-copy";
import {
  useStudioSession,
  type StudioThreadListItem,
} from "../lib/use-studio-session";
import styles from "./studio.module.css";

/**
 * The Conversation Studio shell: a rail plus the page content slot.
 *
 * The rail carries the workspace name, a real "New conversation" action, the
 * four destinations this build implements, and the recent-thread list the
 * layout reads server-side. Settings is not a link because `/studio/settings`
 * does not exist yet: it renders as an explicitly unavailable item rather than
 * a destination that 404s.
 *
 * Creating a conversation is a client action because it is the one thing on the
 * rail that mutates the server. It goes through the shared session hook, so the
 * same in-flight guard prevents a double click from creating two empty threads,
 * and a failure shows localized copy with a retry instead of a raw response.
 */

type RailLink = {
  readonly href: string;
  readonly key: StudioCopyKey;
};

const RAIL_LINKS: readonly RailLink[] = [
  { href: "/studio", key: "studio.rail.overview" },
  { href: "/studio/threads", key: "studio.rail.conversations" },
  { href: "/studio/outputs", key: "studio.rail.outputs" },
  { href: "/studio/connections", key: "studio.rail.tools" },
];

export type StudioShellProps = {
  readonly locale: Locale;
  readonly workspaceName: string;
  readonly recentThreads?: readonly StudioThreadListItem[];
  readonly recentTruncated?: boolean;
  /** Viewers can read Studio but cannot create threads (operator+). */
  readonly canCreateThread?: boolean;
  readonly children: ReactNode;
};

export function StudioShell({
  locale,
  workspaceName,
  recentThreads = [],
  recentTruncated = false,
  canCreateThread = false,
  children,
}: StudioShellProps) {
  const router = useRouter();
  const session = useStudioSession();

  async function handleNewConversation() {
    const threadId = await session.createThread();
    if (threadId) {
      router.push(`/studio/t/${threadId}`);
    }
  }

  const createErrorKey = session.error?.copyKey ?? null;

  return (
    <div className={styles["studio"]}>
      <aside
        className={styles["studio-rail"]}
        aria-label={studioCopy(locale, "studio.rail.navigation")}
      >
        <div className={styles["studio-rail-workspace"]}>
          <span className={styles["studio-rail-eyebrow"]}>
            {studioCopy(locale, "studio.rail.workspace")}
          </span>
          <strong className={styles["studio-rail-workspace-name"]}>
            {workspaceName}
          </strong>
        </div>

        <button
          type="button"
          className={styles["studio-new-conversation"]}
          onClick={() => void handleNewConversation()}
          disabled={!canCreateThread || session.inFlight}
          {...(!canCreateThread
            ? {
                title: studioCopy(
                  locale,
                  "studio.rail.newConversationUnavailable",
                ),
                "aria-describedby": "studio-rail-note",
              }
            : {})}
        >
          {session.status === "creating_thread"
            ? studioCopy(locale, "studio.rail.newConversationCreating")
            : studioCopy(locale, "studio.rail.newConversation")}
        </button>
        {!canCreateThread ? (
          <p id="studio-rail-note" className={styles["studio-rail-note"]}>
            {studioCopy(locale, "studio.rail.newConversationUnavailable")}
          </p>
        ) : null}
        {createErrorKey ? (
          <div className={styles["studio-composer-error"]} role="alert">
            <p>{studioCopy(locale, createErrorKey)}</p>
            <button
              type="button"
              className={styles["studio-composer-retry"]}
              onClick={() => void handleNewConversation()}
              disabled={session.inFlight}
            >
              {studioCopy(locale, "studio.rail.newConversation")}
            </button>
          </div>
        ) : null}

        <nav
          className={styles["studio-rail-nav"]}
          aria-label={studioCopy(locale, "studio.rail.navigation")}
        >
          <ul className={styles["studio-rail-list"]}>
            {RAIL_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={styles["studio-rail-link"]}>
                  {studioCopy(locale, link.key)}
                </Link>
              </li>
            ))}
            <li>
              <span
                className={styles["studio-rail-link"]}
                aria-disabled="true"
                data-unavailable="true"
                title={studioCopy(locale, "studio.rail.settingsUnavailable")}
              >
                {studioCopy(locale, "studio.rail.settings")}
              </span>
            </li>
          </ul>
        </nav>
        <p className={styles["studio-rail-note"]}>
          {studioCopy(locale, "studio.rail.settingsUnavailable")}
        </p>

        <section
          className={styles["studio-rail-recent"]}
          aria-label={studioCopy(locale, "studio.rail.recent")}
        >
          <h2 className={styles["studio-rail-recent-title"]}>
            {studioCopy(locale, "studio.rail.recent")}
          </h2>
          {recentThreads.length === 0 ? (
            <p className={styles["studio-rail-recent-empty"]}>
              {studioCopy(locale, "studio.rail.recentEmpty")}
            </p>
          ) : (
            <ul className={styles["studio-rail-recent-list"]}>
              {recentThreads.map((thread) => (
                <li key={thread.threadId}>
                  <Link
                    className={styles["studio-rail-recent-link"]}
                    href={`/studio/t/${thread.threadId}`}
                  >
                    <span className={styles["studio-rail-recent-name"]}>
                      {thread.title}
                    </span>
                    <span className={styles["studio-rail-recent-time"]}>
                      {formatHkDate(
                        thread.lastMessageAt ?? thread.updatedAt,
                        locale,
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {recentTruncated ? (
            <p className={styles["studio-rail-note"]}>
              {studioCopy(locale, "studio.rail.recentTruncated")}
            </p>
          ) : null}
          <Link href="/studio/threads" className={styles["studio-rail-link"]}>
            {studioCopy(locale, "studio.rail.viewAllThreads")}
          </Link>
        </section>
      </aside>

      <div className={styles["studio-content"]}>{children}</div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

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
 * The rail is grouped by the user's job rather than by delivery milestone —
 * Work (what needs doing), Records (what was saved) and Admin — so the two
 * navigation layers do not read as twenty unrelated links. The current page is
 * marked with `aria-current`, which the previous rail lacked, and Settings and
 * Connections are only rendered for administrators: showing them to an operator
 * led to a "Studio page not found" dead end.
 *
 * Below 960px the rail collapses to a compact bar (workspace, current section,
 * Menu) and only expands on request, so the page content is no longer pushed
 * more than a screen down on phones.
 *
 * Creating a conversation is a client action because it is the one thing on the
 * rail that mutates the server. It goes through the shared session hook, so the
 * same in-flight guard prevents a double click from creating two empty threads,
 * and a failure shows localized copy with a retry instead of a raw response.
 */

type RailLink = {
  readonly href: string;
  readonly key: StudioCopyKey;
  /** Extra path prefixes that belong to this destination (thread detail). */
  readonly alsoMatches?: readonly string[];
};

const WORK_LINKS: readonly RailLink[] = [
  { href: "/studio", key: "studio.rail.overview" },
  { href: "/studio/agents", key: "studio.rail.agents" },
  { href: "/studio/inbox", key: "studio.rail.inbox" },
  { href: "/studio/reviews", key: "studio.rail.reviews" },
  {
    href: "/studio/threads",
    key: "studio.rail.conversations",
    alsoMatches: ["/studio/t/"],
  },
];

const RECORD_LINKS: readonly RailLink[] = [
  { href: "/studio/outputs", key: "studio.rail.outputs" },
];

const ADMIN_LINKS: readonly RailLink[] = [
  { href: "/studio/connections", key: "studio.rail.tools" },
  { href: "/studio/settings", key: "studio.rail.settings" },
];

function isActivePath(pathname: string, link: RailLink): boolean {
  if (link.href === "/studio") return pathname === "/studio";
  if (pathname === link.href || pathname.startsWith(`${link.href}/`)) {
    return true;
  }
  return (link.alsoMatches ?? []).some((prefix) => pathname.startsWith(prefix));
}

export type StudioShellProps = {
  readonly locale: Locale;
  readonly workspaceName: string;
  readonly recentThreads?: readonly StudioThreadListItem[];
  readonly recentTruncated?: boolean;
  /** Viewers can read Studio but cannot create threads (operator+). */
  readonly canCreateThread?: boolean;
  /** Administrators get the Connections and Settings destinations. */
  readonly canAdmin?: boolean;
  readonly children: ReactNode;
};

export function StudioShell({
  locale,
  workspaceName,
  recentThreads = [],
  recentTruncated = false,
  canCreateThread = false,
  canAdmin = false,
  children,
}: StudioShellProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/studio";
  const session = useStudioSession();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleNewConversation() {
    const threadId = await session.createThread();
    if (threadId) {
      router.push(`/studio/t/${threadId}`);
    }
  }

  const createErrorKey = session.error?.copyKey ?? null;

  const activeLink =
    [...WORK_LINKS, ...RECORD_LINKS, ...ADMIN_LINKS].find((link) =>
      isActivePath(pathname, link),
    ) ?? null;

  function renderLink(link: RailLink) {
    const active = isActivePath(pathname, link);
    return (
      <li key={link.href}>
        <Link
          href={link.href}
          className={styles["studio-rail-link"]}
          {...(active ? { "aria-current": "page" as const } : {})}
          data-active={active ? "true" : undefined}
        >
          {studioCopy(locale, link.key)}
        </Link>
      </li>
    );
  }

  function renderGroup(labelKey: StudioCopyKey, links: readonly RailLink[]) {
    return (
      <div
        className={styles["studio-rail-group"]}
        role="group"
        aria-label={studioCopy(locale, labelKey)}
      >
        <p className={styles["studio-rail-group-label"]}>
          {studioCopy(locale, labelKey)}
        </p>
        <ul className={styles["studio-rail-list"]}>{links.map(renderLink)}</ul>
      </div>
    );
  }

  return (
    <div className={styles["studio"]}>
      <aside
        className={styles["studio-rail"]}
        aria-label={studioCopy(locale, "studio.rail.navigation")}
        data-open={menuOpen ? "true" : "false"}
      >
        <div className={styles["studio-rail-head"]}>
          <div className={styles["studio-rail-workspace"]}>
            <span className={styles["studio-rail-eyebrow"]}>
              {studioCopy(locale, "studio.rail.workspace")}
            </span>
            <strong className={styles["studio-rail-workspace-name"]}>
              {workspaceName}
            </strong>
            {activeLink ? (
              <span className={styles["studio-rail-current"]}>
                {studioCopy(locale, activeLink.key)}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className={styles["studio-rail-toggle"]}
            aria-expanded={menuOpen}
            aria-controls="studio-rail-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {studioCopy(
              locale,
              menuOpen ? "studio.rail.menuClose" : "studio.rail.menu",
            )}
          </button>
        </div>

        <div id="studio-rail-menu" className={styles["studio-rail-menu"]}>
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
            {renderGroup("studio.rail.group.work", WORK_LINKS)}
            {renderGroup("studio.rail.group.records", RECORD_LINKS)}
            {canAdmin
              ? renderGroup("studio.rail.group.admin", ADMIN_LINKS)
              : null}
          </nav>

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
        </div>
      </aside>

      <div className={styles["studio-content"]}>{children}</div>
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The Conversation Studio shell: a rail plus the page content slot.
 *
 * Deliberately a server component. P1 has no client state -- New conversation
 * is a disabled button, not an optimistic action -- so adding hooks here would
 * hydrate a page that has nothing to hydrate. Task 7 replaces this static
 * shell with the interactive one once threads exist.
 *
 * The rail links point at the routes the design spec defines (§2.1). Only
 * `/studio` exists in this build, so the rail says so honestly instead of
 * looking like a working set of destinations.
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
  { href: "/studio/settings", key: "studio.rail.settings" },
];

export type StudioShellProps = {
  readonly locale: Locale;
  readonly workspaceName: string;
  readonly children: ReactNode;
};

export function StudioShell({
  locale,
  workspaceName,
  children,
}: StudioShellProps) {
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
          disabled
          aria-describedby="studio-rail-note"
          title={studioCopy(locale, "studio.rail.newConversationUnavailable")}
        >
          {studioCopy(locale, "studio.rail.newConversation")}
        </button>
        <p id="studio-rail-note" className={styles["studio-rail-note"]}>
          {studioCopy(locale, "studio.rail.notAvailableInBuild")}
        </p>

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
          </ul>
        </nav>

        <section
          className={styles["studio-rail-recent"]}
          aria-label={studioCopy(locale, "studio.rail.recent")}
        >
          <h2 className={styles["studio-rail-recent-title"]}>
            {studioCopy(locale, "studio.rail.recent")}
          </h2>
          <p className={styles["studio-rail-recent-empty"]}>
            {studioCopy(locale, "studio.rail.recentEmpty")}
          </p>
        </section>
      </aside>

      <div className={styles["studio-content"]}>{children}</div>
    </div>
  );
}

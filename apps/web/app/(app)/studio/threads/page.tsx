import Link from "next/link";
import { cookies } from "next/headers";

import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { studioCopy } from "../../../../lib/studio-copy";
import { formatHkDate } from "../../../../lib/ui-copy";
import styles from "../../../../components/studio.module.css";
import { studioService } from "../studio-service";

/**
 * All conversations (design spec §2.1), read server-side through the same
 * service the API uses so visibility rules cannot diverge from the endpoints.
 *
 * Search is a plain GET query parameter filtered over the listed page: no new
 * read surface, no client fetch and no hidden second query. A failed read shows
 * the honest failure line rather than an empty list that would imply "no
 * conversations".
 */
function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export default async function StudioThreadsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const query = (firstParam(params.q) ?? "").trim();

  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  let listed;
  try {
    listed = await studioService().listThreads();
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "studio_threads_read_failed",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return (
      <div className={styles["studio-section"]}>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.threads.title")}
        </h1>
        <p className={styles["studio-notice"]} role="alert">
          {studioCopy(locale, "studio.threads.error")}
        </p>
      </div>
    );
  }

  const normalizedQuery = query.toLocaleLowerCase();
  const items =
    normalizedQuery.length === 0
      ? listed.items
      : listed.items.filter((thread) =>
          `${thread.title} ${thread.skillKey ?? ""}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        );

  return (
    <div className={styles["studio-section"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.rail.conversations")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.threads.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.threads.intro")}
        </p>
      </header>

      <form
        className={styles["studio-thread-search"]}
        action="/studio/threads"
        method="get"
        role="search"
      >
        <label
          className={styles["studio-visually-hidden"]}
          htmlFor="studio-threads-search"
        >
          {studioCopy(locale, "studio.threads.searchLabel")}
        </label>
        <input
          id="studio-threads-search"
          className={styles["studio-thread-search-input"]}
          type="search"
          name="q"
          defaultValue={query}
          placeholder={studioCopy(locale, "studio.threads.searchPlaceholder")}
        />
        <button type="submit" className={styles["studio-secondary-button"]}>
          {studioCopy(locale, "studio.threads.searchAction")}
        </button>
      </form>

      {listed.truncated ? (
        <p className={styles["studio-notice"]}>
          {studioCopy(locale, "studio.threads.truncated")}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className={styles["studio-empty"]}>
          {query.length > 0
            ? studioCopy(locale, "studio.threads.searchEmpty")
            : studioCopy(locale, "studio.threads.empty")}
        </p>
      ) : (
        <ul className={styles["studio-thread-index"]}>
          {items.map((thread) => (
            <li
              key={thread.threadId}
              className={styles["studio-thread-index-item"]}
            >
              <Link
                className={styles["studio-thread-index-link"]}
                href={`/studio/t/${thread.threadId}`}
              >
                <span className={styles["studio-thread-index-title"]}>
                  {thread.title}
                </span>
                <span className={styles["studio-thread-index-meta"]}>
                  {studioCopy(locale, "studio.threads.updated")}:{" "}
                  <time dateTime={thread.lastMessageAt ?? thread.updatedAt}>
                    {formatHkDate(
                      thread.lastMessageAt ?? thread.updatedAt,
                      locale,
                    )}
                  </time>
                  {thread.skillKey
                    ? ` · ${studioCopy(locale, "studio.thread.skill")}: ${thread.skillKey}`
                    : ""}
                </span>
              </Link>
              <span
                className={styles["studio-badge"]}
                data-status={thread.status}
              >
                {studioCopy(
                  locale,
                  thread.status === "archived"
                    ? "studio.thread.status.archived"
                    : "studio.thread.status.open",
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

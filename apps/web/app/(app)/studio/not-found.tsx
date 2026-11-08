import { cookies } from "next/headers";
import Link from "next/link";

import styles from "../../../components/studio.module.css";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import { studioCopy } from "../../../lib/studio-copy";

/**
 * Not-found boundary for `/studio`.
 *
 * Reached when the layout flags the workspace out (`notFound()`) and when a
 * thread or output id is foreign or missing - ids reveal nothing, so the
 * answer is always 404, never 403. The copy states the honest causes and
 * points back to the Workbench, because the Studio nav item is hidden when
 * Studio is not enabled for the workspace.
 */
export default async function StudioNotFound() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  return (
    <div className={styles["studio-state-page"]}>
      <p className={styles["studio-eyebrow"]}>STUDIO · 404</p>
      <h1 className={styles["studio-state-title"]}>
        {studioCopy(locale, "studio.notFound.title")}
      </h1>
      <p className={styles["studio-state-body"]}>
        {studioCopy(locale, "studio.notFound.body")}
      </p>
      <Link className={styles["studio-state-link"]} href="/dashboard">
        {studioCopy(locale, "studio.notFound.back")}
      </Link>
    </div>
  );
}

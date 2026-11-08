import Link from "next/link";

import styles from "../../../components/studio.module.css";

/**
 * Not-found boundary for `/studio`.
 *
 * Reached when the layout flags the workspace out (`notFound()`) and, later,
 * when a thread or output id is foreign or missing -- ids reveal nothing, so
 * the answer is always 404, never 403. The copy states the two honest causes
 * (page missing, Studio not enabled) and points back to the Workbench, because
 * the Studio nav item is hidden in either case.
 */
export default function StudioNotFound() {
  return (
    <div className={styles["studio-state-page"]}>
      <p className={styles["studio-eyebrow"]}>STUDIO · 404</p>
      <h1 className={styles["studio-state-title"]}>
        找不到工作室頁面 Studio page not found
      </h1>
      <p className={styles["studio-state-body"]}>
        此頁面不存在，或工作室未為此工作區啟用。 This page does not exist, or
        Studio is not enabled for this workspace.
      </p>
      <Link className={styles["studio-state-link"]} href="/dashboard">
        返回工作台 Return to Workbench
      </Link>
    </div>
  );
}

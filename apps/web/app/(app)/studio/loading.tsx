import styles from "../../../components/studio.module.css";

/**
 * `/studio` route loading state.
 *
 * Kept intentionally bilateral rather than locale-resolved: a loading
 * boundary may render before any cookie/session read settles, so it must not
 * depend on request-scoped APIs. Text only, no spinner animation, so
 * `prefers-reduced-motion` users see nothing moving.
 */
export default function StudioLoading() {
  return (
    <div
      className={styles["studio-state-page"]}
      role="status"
      aria-live="polite"
    >
      <p className={styles["studio-state-body"]}>
        正在載入工作室… Loading Studio…
      </p>
    </div>
  );
}

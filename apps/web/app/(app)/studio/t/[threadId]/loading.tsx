import { studioCopy } from "../../../../../lib/studio-copy";
import styles from "../../../../../components/studio.module.css";

/**
 * `/studio/t/[threadId]` loading state.
 *
 * Bilingual rather than locale-resolved for the same reason as the `/studio`
 * loading boundary: a loading boundary may render before any cookie/session
 * read settles, so it must not depend on request-scoped APIs. The string comes
 * from the shared copy catalogue in both languages, so it is not a second
 * translation of the same sentence. Text only, no animation.
 */
export default function StudioThreadLoading() {
  return (
    <div
      className={styles["studio-state-page"]}
      role="status"
      aria-live="polite"
    >
      <p className={styles["studio-state-body"]}>
        {`${studioCopy("zh-Hant", "studio.thread.loading")} ${studioCopy(
          "en",
          "studio.thread.loading",
        )}`}
      </p>
    </div>
  );
}

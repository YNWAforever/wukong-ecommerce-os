import { cookies } from "next/headers";

import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { studioCopy } from "../../../../lib/studio-copy";
import styles from "../../../../components/studio.module.css";

/**
 * `/studio/outputs` — honest empty surface until Task 9.
 *
 * No saved artifact exists in this phase, so the page says exactly that and
 * shows no fabricated proposal, version, as-of time or sign-off state. The
 * layout gate still applies, and the empty state names what will fill it.
 */
export default async function StudioOutputsPage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <div className={styles["studio-section"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.rail.outputs")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.outputs.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.outputs.intro")}
        </p>
      </header>
      <p className={styles["studio-empty"]}>
        {studioCopy(locale, "studio.outputs.empty")}
      </p>
      <p className={styles["studio-notice"]}>
        {studioCopy(locale, "studio.outputs.pending")}
      </p>
    </div>
  );
}

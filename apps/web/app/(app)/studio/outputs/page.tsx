import { cookies } from "next/headers";

import {
  StudioOutputCard,
  toOutputStatus,
} from "../../../../components/studio-output-card";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import { studioCopy } from "../../../../lib/studio-copy";
import styles from "../../../../components/studio.module.css";
import { studioService } from "../studio-service";

/**
 * `/studio/outputs` — saved artifacts (plan Task 9, design spec §2.1).
 *
 * The list comes from the deterministic output service: an artifact row is
 * rendered inside the same `StudioOutputCard` the thread uses, so the version,
 * as-of time, content digest and status are read from the API rather than
 * re-derived here. The collapsed row shows only the fields the list read
 * returned (kind, title, status) and loads the version content when opened, so
 * a page of artifacts does not fetch every payload up front.
 *
 * Sign-off is gated by the role resolved server-side from the session; an
 * artifact's own status still decides whether the button is meaningful (draft
 * must be saved first, signed-off artifacts are final).
 *
 * A failed list read shows an honest failure line rather than an empty list
 * that would imply "no artifacts exist".
 */
export default async function StudioOutputsPage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  const session = await authSessionContext.resolve();
  const canSignOff = session
    ? requireWorkspaceRole("reviewer", session.role)
    : false;

  let listed;
  try {
    listed = await studioService().listOutputs();
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "studio_outputs_read_failed",
        outcome: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return (
      <div className={styles["studio-section"]}>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.outputs.title")}
        </h1>
        <p className={styles["studio-notice"]} role="alert">
          {studioCopy(locale, "studio.outputs.listError")}
        </p>
      </div>
    );
  }

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

      {listed.truncated ? (
        <p className={styles["studio-notice"]}>
          {studioCopy(locale, "studio.outputs.truncated")}
        </p>
      ) : null}

      {listed.items.length === 0 ? (
        <>
          <p className={styles["studio-empty"]}>
            {studioCopy(locale, "studio.outputs.empty")}
          </p>
          <p className={styles["studio-notice"]}>
            {studioCopy(locale, "studio.outputs.emptyHint")}
          </p>
        </>
      ) : (
        <ul className={styles["studio-output-index"]}>
          {listed.items.map((item) => (
            <li key={item.outputId}>
              <StudioOutputCard
                locale={locale}
                outputId={item.outputId}
                canSignOff={canSignOff}
                expandable
                initialSummary={{
                  kind: item.kind,
                  title: item.title,
                  status: toOutputStatus(item.status),
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

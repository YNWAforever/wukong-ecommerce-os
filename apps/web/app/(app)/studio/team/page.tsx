import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { AdminMembersEditor } from "../../../../components/admin-tabs";
import styles from "../../../../components/studio.module.css";
import { getDatabase } from "../../../../lib/intake-runtime";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { ApiError } from "../../../../lib/route-support";
import { roleLabel } from "../../../../lib/role-labels";
import { roleGuideText, TEAM_ROLE_ORDER } from "../../../../lib/role-guide";
import { authSessionContext } from "../../../../lib/session-context";
import { isStudioEnabled } from "../../../../lib/studio-flags";
import { requireStudioSession } from "../../../../lib/studio/session";
import { studioCopy } from "../../../../lib/studio-copy";

/**
 * `/studio/team` — member, role and invitation administration for admins.
 *
 * The plan card shows seats; this is where an admin actually changes them. It
 * reuses the existing members panel and its audited API routes rather than
 * introducing a second member-management implementation.
 */
export default async function StudioTeamPage() {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");

  await requireStudioSession(
    {
      sessionContext: authSessionContext,
      getDatabase,
      isStudioEnabled,
    },
    "admin",
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) redirect("/signin");
    notFound();
  });

  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const copy = (key: Parameters<typeof studioCopy>[1]) =>
    studioCopy(locale, key);

  return (
    <>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {copy("studio.team.eyebrow")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {copy("studio.team.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>{copy("studio.team.lede")}</p>
        <p className={styles["studio-notice"]} role="note">
          {copy("studio.team.note")}
        </p>
      </header>

      <section
        className={styles["studio-section"]}
        aria-label={copy("studio.team.rolesTitle")}
      >
        <div className={styles["studio-section-header"]}>
          <h2 className={styles["studio-section-title"]}>
            {copy("studio.team.rolesTitle")}
          </h2>
        </div>
        <ul className={styles["studio-role-grid"]}>
          {TEAM_ROLE_ORDER.map((role) => (
            <li key={role} className={styles["studio-role-card"]}>
              <h3 className={styles["studio-role-name"]}>
                {roleLabel(role, locale)}
              </h3>
              <p className={styles["studio-role-copy"]}>
                {roleGuideText(role, locale)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={copy("studio.team.membersTitle")}
      >
        <div className={styles["studio-section-header"]}>
          <h2 className={styles["studio-section-title"]}>
            {copy("studio.team.membersTitle")}
          </h2>
          <p className={styles["studio-section-lede"]}>
            {copy("studio.team.membersLede")}
          </p>
        </div>
        <div className={styles["studio-team-table"]}>
          <AdminMembersEditor />
        </div>
      </section>
    </>
  );
}

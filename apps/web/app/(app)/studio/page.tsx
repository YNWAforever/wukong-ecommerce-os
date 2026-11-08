import { cookies } from "next/headers";

import { StudioHome } from "../../../components/studio-home";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";
import { studioService } from "./studio-service";

/**
 * Conversation home (plan Task 7).
 *
 * The layout has already enforced session, workspace settings and flags. This
 * page reads the deterministic overview from canonical workspace records — no
 * model call, no budget reservation — and hands it to `StudioHome`, which also
 * states the "From workspace records; no AI call." rule.
 *
 * A failed overview read fails closed to `null`: the component then shows the
 * honest unavailable/empty states instead of zeroes or an error page, because
 * one unavailable read is not a reason to take the whole Studio surface down.
 */
export default async function StudioHomePage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  const session = await authSessionContext.resolve();
  const canCreateThread = session
    ? requireWorkspaceRole("operator", session.role)
    : false;

  const overview = await studioService()
    .overview()
    .catch((error: unknown) => {
      console.info(
        JSON.stringify({
          event: "studio_home_overview_read_failed",
          outcome: "failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return null;
    });

  return (
    <StudioHome
      locale={locale}
      overview={overview}
      canCreateThread={canCreateThread}
    />
  );
}

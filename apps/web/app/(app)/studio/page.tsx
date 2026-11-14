import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ApiError } from "../../../lib/route-support";

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
export default async function StudioHomePage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{
    guideListing?: string | string[];
    guideVersion?: string | string[];
  }>;
} = {}) {
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

  const query = await searchParams;
  let initialGuidedAction;
  let guideUnavailable = false;
  if (
    canCreateThread &&
    (query.guideListing !== undefined || query.guideVersion !== undefined)
  ) {
    if (
      typeof query.guideListing !== "string" ||
      typeof query.guideVersion !== "string"
    )
      guideUnavailable = true;
    else {
      try {
        initialGuidedAction = await studioService().guidedEntry({
          kind: "audit",
          listingId: query.guideListing,
          expectedActiveVersionId:
            query.guideVersion === "none" ? null : query.guideVersion,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) notFound();
        if (error instanceof ApiError && [403, 409].includes(error.status))
          guideUnavailable = true;
        else throw error;
      }
    }
  }
  return (
    <StudioHome
      locale={locale}
      overview={overview}
      canCreateThread={canCreateThread}
      {...(initialGuidedAction ? { initialGuidedAction } : {})}
      guideUnavailable={guideUnavailable}
    />
  );
}

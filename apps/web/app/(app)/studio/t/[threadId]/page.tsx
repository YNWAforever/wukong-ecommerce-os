import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { StudioThreadView } from "../../../../../components/studio-thread-view";
import { ApiError } from "../../../../../lib/route-support";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import { studioAiEnabled, studioService } from "../../studio-service";

/**
 * One conversation thread (plan Task 7).
 *
 * The layout gate has already run. `getThread` enforces the same workspace and
 * thread-visibility rules as the API, so a foreign, private or malformed id
 * throws the shared 404 `ApiError` and this page calls `notFound()` — ids
 * reveal nothing and a 403 would confirm that a thread exists elsewhere.
 *
 * The action capabilities (`canSend`, `canSignOff`) are resolved from the server
 * session here and passed as props: the thread view never infers a role, and the
 * API re-checks the same floors before any write.
 */
export default async function StudioThreadPage({
  params,
}: {
  readonly params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;

  let result;
  try {
    result = await studioService().getThread(threadId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  const session = await authSessionContext.resolve();
  const canSend = session
    ? requireWorkspaceRole("operator", session.role)
    : false;
  const canSignOff = session
    ? requireWorkspaceRole("reviewer", session.role)
    : false;
  const aiEnabled = await studioAiEnabled();
  const canGuide = canSend ? await studioService().guidedAvailability() : false;

  return (
    <StudioThreadView
      locale={locale}
      thread={result.thread}
      messages={result.messages}
      aiEnabled={aiEnabled}
      canSend={canSend}
      canSignOff={canSignOff}
      canGuide={canGuide}
      {...(result.latestGuidedAttempt !== undefined
        ? { latestGuidedAttempt: result.latestGuidedAttempt }
        : {})}
    />
  );
}

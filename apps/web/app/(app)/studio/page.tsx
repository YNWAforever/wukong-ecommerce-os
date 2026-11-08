import { cookies } from "next/headers";

import { StudioHome } from "../../../components/studio-home";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

/**
 * Conversation home.
 *
 * The layout has already enforced session, workspace settings and flags; this
 * page is deliberately static: no fetch, no model call, no fabricated numbers.
 * `StudioHome` renders the honest placeholder overview and disabled composer
 * until Tasks 5-7 land the records read and turn services.
 */
export default async function StudioHomePage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return <StudioHome locale={locale} />;
}

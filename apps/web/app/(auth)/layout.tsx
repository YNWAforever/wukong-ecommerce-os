import { cookies } from "next/headers";

import { AuthShell } from "../../components/auth-shell";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../lib/locale";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return <AuthShell initialLocale={locale}>{children}</AuthShell>;
}

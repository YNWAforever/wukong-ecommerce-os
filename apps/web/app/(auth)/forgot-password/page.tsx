import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ForgotPasswordPage({ searchParams }: PageProps) {
  const value = (await searchParams)?.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 密碼復原" : "Wukong password recovery"}
    >
      <AuthForm
        mode="forgot-password"
        locale={locale}
        callbackUrl={callbackUrl}
      />
    </section>
  );
}

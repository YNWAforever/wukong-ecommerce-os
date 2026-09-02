import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = (await searchParams) ?? {};
  const value = params.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  const initialStatus =
    params.registered === "1"
      ? isZh
        ? "你的密碼已就緒。請登入以繼續。"
        : "Your password is ready. Sign in to continue."
      : params.reset === "1"
        ? isZh
          ? "你的密碼已重設。請登入以繼續。"
          : "Your password has been reset. Sign in to continue."
        : "";
  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 登入" : "Wukong sign in"}
    >
      <p className="auth-card-eyebrow">{isZh ? "歡迎回來" : "Welcome back"}</p>
      <AuthForm
        mode="password-signin"
        locale={locale}
        callbackUrl={callbackUrl}
        initialStatus={initialStatus}
      />
    </section>
  );
}

import Link from "next/link";
import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const callbackUrl = Array.isArray(params.callbackUrl)
    ? params.callbackUrl[0]
    : params.callbackUrl;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  if (!token) {
    return (
      <section
        className="auth-card"
        aria-label={isZh ? "連結已失效" : "Link no longer valid"}
      >
        <p className="auth-card-eyebrow">
          {isZh ? "連結已過期" : "Link expired"}
        </p>
        <h1>
          {isZh
            ? "這個密碼重設連結已失效"
            : "This password reset link is no longer valid"}
        </h1>
        <p>
          {isZh
            ? "重設連結只在短時間內有效。請重新申請一個新的重設連結。"
            : "Reset links are only valid for a short time. Request a new one to continue."}
        </p>
        <Link className="primary-button" href="/forgot-password">
          {isZh ? "重新申請重設連結" : "Request a new reset link"}
        </Link>
      </section>
    );
  }

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 密碼重設" : "Wukong password reset"}
    >
      <AuthForm
        mode="reset-password"
        locale={locale}
        token={token}
        callbackUrl={callbackUrl}
      />
    </section>
  );
}

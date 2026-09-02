import Link from "next/link";
import { cookies } from "next/headers";

import { AuthForm } from "../../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SetPasswordPage({ searchParams }: PageProps) {
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
        aria-label={isZh ? "邀請連結已失效" : "Invitation link no longer valid"}
      >
        <p className="auth-card-eyebrow">
          {isZh ? "邀請連結已過期" : "Invitation link expired"}
        </p>
        <h1>
          {isZh
            ? "這個邀請連結已失效"
            : "This invitation link is no longer valid"}
        </h1>
        <p>
          {isZh
            ? "請聯絡你的工作區管理員，請求一個新的邀請。"
            : "Contact your workspace administrator to request a new invitation."}
        </p>
        <Link className="primary-button" href="/signin">
          {isZh ? "返回登入" : "Back to sign in"}
        </Link>
      </section>
    );
  }

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 密碼設定" : "Wukong password setup"}
    >
      <AuthForm
        mode="set-password"
        locale={locale}
        token={token}
        callbackUrl={callbackUrl}
      />
    </section>
  );
}

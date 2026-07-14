type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function safeCallbackUrl(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate?.startsWith("/") || candidate.startsWith("//")) {
    return "/dashboard";
  }
  return candidate;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = (await searchParams) ?? {};
  const callbackUrl = safeCallbackUrl(params.callbackUrl);
  const authHref = `/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  return (
    <main className="signin-shell">
      <section className="signin-card" aria-labelledby="signin-title">
        <div className="signin-brand" aria-hidden="true">W</div>
        <p className="eyebrow">Wukong · Opak Cellar</p>
        <h1 id="signin-title">登入 Opak 工作區</h1>
        <p className="signin-intro">
          此試用工作區採用邀請制。請使用已獲邀請的電郵地址取得登入連結。
        </p>
        <a className="primary-button signin-action" href={authHref}>
          以電郵登入 <span>Continue with email</span>
        </a>
        <p className="signin-note">
          只有已獲邀請的 Opak 團隊成員可以存取產品資料及 SHOPLINE 發佈功能。
        </p>
      </section>
    </main>
  );
}

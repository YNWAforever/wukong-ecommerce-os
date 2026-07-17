import { AuthForm } from "../../../components/auth-form";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};
export default async function SetPasswordPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const callbackUrl = Array.isArray(params.callbackUrl)
    ? params.callbackUrl[0]
    : params.callbackUrl;
  return (
    <main className="signin-shell">
      <section className="signin-card" aria-label="Opak Cellar password setup">
        <div className="signin-brand" aria-hidden="true">
          W
        </div>
        <p className="eyebrow">Wukong / Opak Cellar</p>
        <AuthForm mode="set-password" token={token} callbackUrl={callbackUrl} />
      </section>
    </main>
  );
}

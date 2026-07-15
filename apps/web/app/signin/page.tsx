import { AuthForm } from "../../components/auth-form";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = (await searchParams) ?? {};
  const value = params.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;

  const initialStatus =
    params.registered === "1"
      ? "Your password is ready. Sign in to continue."
      : params.reset === "1"
        ? "Your password has been reset. Sign in to continue."
        : "";
  return (
    <main className="signin-shell">
      <section className="signin-card" aria-label="Opak Cellar sign in">
        <div className="signin-brand" aria-hidden="true">
          W
        </div>
        <p className="eyebrow">Wukong / Opak Cellar</p>
        <AuthForm
          mode="password-signin"
          callbackUrl={callbackUrl}
          initialStatus={initialStatus}
        />
      </section>
    </main>
  );
}

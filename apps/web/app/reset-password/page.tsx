import { AuthForm } from "../../components/auth-form";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};
export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const value = (await searchParams)?.token;
  const token = Array.isArray(value) ? value[0] : value;
  return (
    <main className="signin-shell">
      <section className="signin-card" aria-label="Opak Cellar password reset">
        <div className="signin-brand" aria-hidden="true">
          W
        </div>
        <p className="eyebrow">Wukong / Opak Cellar</p>
        <AuthForm mode="reset-password" token={token} />
      </section>
    </main>
  );
}

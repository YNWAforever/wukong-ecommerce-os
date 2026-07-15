import { AuthForm } from "../../components/auth-form";

export default function RegisterPage() {
  return (
    <main className="signin-shell">
      <section className="signin-card" aria-label="Opak Cellar registration">
        <div className="signin-brand" aria-hidden="true">
          W
        </div>
        <p className="eyebrow">Wukong / Opak Cellar</p>
        <AuthForm mode="register" />
      </section>
    </main>
  );
}

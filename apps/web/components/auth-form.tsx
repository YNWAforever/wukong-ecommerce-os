"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

export type AuthFormMode =
  | "password-signin"
  | "magic-link"
  | "register"
  | "set-password"
  | "forgot-password"
  | "reset-password";

type AuthFormProps = {
  mode: AuthFormMode;
  callbackUrl?: string;
  token?: string;
};

const GENERIC_ERROR = "Unable to complete this request.";
const EMAIL_SUCCESS =
  "If this address is eligible, an email will arrive shortly.";
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

export function safeCallbackPath(value?: string): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/dashboard";
  }
  return value;
}

function modeCopy(mode: AuthFormMode) {
  switch (mode) {
    case "password-signin":
      return {
        heading: "Welcome back",
        intro: "Sign in to manage Opak Cellar listings.",
        submit: "Sign in with password",
      };
    case "magic-link":
      return {
        heading: "Email sign-in",
        intro: "Request a secure sign-in link for your inbox.",
        submit: "Email me a magic link",
      };
    case "register":
      return {
        heading: "Request admin access",
        intro: "Use the invited email address to begin registration.",
        submit: "Send registration email",
      };
    case "set-password":
      return {
        heading: "Create your password",
        intro: "Finish your verified registration with a secure password.",
        submit: "Create password",
      };
    case "forgot-password":
      return {
        heading: "Reset your password",
        intro: "Request a secure password reset email.",
        submit: "Send reset email",
      };
    case "reset-password":
      return {
        heading: "Choose a new password",
        intro: "Enter and confirm your new password.",
        submit: "Reset password",
      };
  }
}

function isPasswordMode(mode: AuthFormMode) {
  return (
    mode === "password-signin" ||
    mode === "set-password" ||
    mode === "reset-password"
  );
}

function isCompletionMode(mode: AuthFormMode) {
  return mode === "set-password" || mode === "reset-password";
}

export function AuthForm({ mode, callbackUrl, token }: AuthFormProps) {
  const router = useRouter();
  const [signinMode, setSigninMode] = useState<
    "password-signin" | "magic-link"
  >(mode === "magic-link" ? "magic-link" : "password-signin");
  const [status, setStatus] = useState("");
  const [isPending, startTransition] = useTransition();
  const activeMode =
    mode === "password-signin" || mode === "magic-link" ? signinMode : mode;
  const copy = modeCopy(activeMode);
  const callback = safeCallbackPath(callbackUrl);

  function selectSigninMode(nextMode: "password-signin" | "magic-link") {
    setStatus("");
    setSigninMode(nextMode);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");

    if (
      isPasswordMode(activeMode) &&
      (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
    ) {
      setStatus("Password must be between 12 and 128 characters.");
      return;
    }
    if (isCompletionMode(activeMode) && password !== confirmPassword) {
      setStatus("Passwords must match.");
      return;
    }
    if (isCompletionMode(activeMode) && !token) {
      setStatus(GENERIC_ERROR);
      return;
    }

    startTransition(async () => {
      setStatus("");
      const request = (() => {
        switch (activeMode) {
          case "password-signin":
            return [
              "/api/auth/password",
              { email, password, callbackURL: callback },
            ] as const;
          case "magic-link":
            return [
              "/api/auth/magic-link",
              { email, callbackURL: callback },
            ] as const;
          case "register":
            return ["/api/auth/register", { email }] as const;
          case "forgot-password":
            return [
              "/api/auth/forgot-password",
              { email, callbackURL: callback },
            ] as const;
          case "set-password":
          case "reset-password":
            return [
              "/api/auth/reset-password",
              { newPassword: password, token },
            ] as const;
        }
      })();

      try {
        const response = await fetch(request[0], {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify(request[1]),
        });
        if (!response.ok) {
          setStatus(GENERIC_ERROR);
          return;
        }
        if (activeMode === "password-signin") {
          router.push(callback);
          return;
        }
        if (activeMode === "set-password") {
          router.push("/signin?registered=1");
          return;
        }
        if (activeMode === "reset-password") {
          router.push("/signin?reset=1");
          return;
        }
        setStatus(EMAIL_SUCCESS);
      } catch {
        setStatus(GENERIC_ERROR);
      }
    });
  }

  return (
    <>
      {mode === "password-signin" || mode === "magic-link" ? (
        <div className="auth-tabs" aria-label="Sign-in method">
          <button
            type="button"
            aria-pressed={activeMode === "password-signin"}
            onClick={() => selectSigninMode("password-signin")}
          >
            Password
          </button>
          <button
            type="button"
            aria-pressed={activeMode === "magic-link"}
            onClick={() => selectSigninMode("magic-link")}
          >
            Magic link
          </button>
        </div>
      ) : null}
      <div className="auth-heading">
        <h1 id="auth-title">{copy.heading}</h1>
        <p>{copy.intro}</p>
      </div>
      <form
        className="auth-form"
        onSubmit={handleSubmit}
        aria-labelledby="auth-title"
      >
        {!isCompletionMode(activeMode) ? (
          <div className="auth-field">
            <label htmlFor={"auth-email-" + activeMode}>Email address</label>
            <input
              id={"auth-email-" + activeMode}
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={isPending}
            />
          </div>
        ) : null}
        {isPasswordMode(activeMode) ? (
          <div className="auth-field">
            <label htmlFor={"auth-password-" + activeMode}>
              {isCompletionMode(activeMode) ? "New password" : "Password"}
            </label>
            <input
              id={"auth-password-" + activeMode}
              name="password"
              type="password"
              autoComplete={
                isCompletionMode(activeMode)
                  ? "new-password"
                  : "current-password"
              }
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              required
              disabled={isPending}
            />
            <small>Use 12 to 128 characters.</small>
          </div>
        ) : null}
        {isCompletionMode(activeMode) ? (
          <div className="auth-field">
            <label htmlFor={"auth-confirm-" + activeMode}>
              Confirm new password
            </label>
            <input
              id={"auth-confirm-" + activeMode}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              required
              disabled={isPending}
            />
          </div>
        ) : null}
        <input type="hidden" name="callbackURL" value={callback} />
        <button
          className="primary-button auth-submit"
          type="submit"
          disabled={isPending}
        >
          {isPending ? "Please wait..." : copy.submit}
        </button>
        <p className="auth-status" role="status" aria-live="polite">
          {status || "\u00a0"}
        </p>
      </form>
      <nav className="auth-links" aria-label="Account help">
        {activeMode === "password-signin" ? (
          <Link href="/forgot-password">Forgot password?</Link>
        ) : null}
        {activeMode === "password-signin" ? (
          <Link href="/register">Register with an invitation</Link>
        ) : null}
        {activeMode !== "password-signin" && activeMode !== "magic-link" ? (
          <Link href="/signin">Back to sign in</Link>
        ) : null}
      </nav>
    </>
  );
}

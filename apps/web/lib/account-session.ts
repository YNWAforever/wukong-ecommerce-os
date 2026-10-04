export type SignOutDependencies = {
  fetch: typeof fetch;
  clearSession(): void;
  clearCaches(): Promise<void>;
  navigate(url: string): void;
};

export async function signOutAccount(deps: SignOutDependencies): Promise<void> {
  const response = await deps.fetch("/api/account/sign-out", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("Could not sign out");
  // Server revocation is authoritative; unavailable browser storage must not
  // keep the user on a protected screen after their session has been revoked.
  try {
    deps.clearSession();
  } catch {}
  try {
    await deps.clearCaches();
  } catch {}
  deps.navigate("/signin");
}

export function validateSupportRequestId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value.toLowerCase()
    : null;
}

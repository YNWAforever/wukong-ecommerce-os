/**
 * Pure allowlist helpers, safe to import from server auth code.
 *
 * Kept separate from `ops-access.ts` because that module touches request
 * headers, while the auth flow needs the same exact-match rule without pulling
 * request state into its tests.
 */
export function parseOpsAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
  );
}

export function isOpsOperatorEmail(
  email: string | null | undefined,
  allowlist: string | undefined,
): boolean {
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized && parseOpsAllowlist(allowlist).has(normalized));
}

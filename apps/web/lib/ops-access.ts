import { headers } from "next/headers";

/**
 * Internal pilot-lead access is deliberately separate from workspace roles.
 *
 * A tenant owner must never see another merchant's sales lead, and an operator
 * may have no workspace at all. The allowlist is a server-only env value; an
 * absent or empty list denies everyone. This is an internal staff gate, not a
 * replacement for authentication: the email comes from the resolved Better Auth
 * session, never from request input.
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

export type OpsIdentity = { userId: string; email: string };

export async function resolveOpsOperator(): Promise<OpsIdentity | null> {
  try {
    const { auth } = await import("../auth");
    const session = await auth.api.getSession({ headers: await headers() });
    const userId = session?.user?.id;
    const email = session?.user?.email?.trim().toLowerCase();
    if (
      !userId ||
      !email ||
      !isOpsOperatorEmail(email, process.env.OPS_LEAD_EMAILS)
    )
      return null;
    return { userId, email };
  } catch {
    // Fail closed: an auth/configuration failure must not expose leads.
    return null;
  }
}

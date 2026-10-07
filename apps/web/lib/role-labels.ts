import type { Locale } from "./locale";
import type { SessionContext } from "./session-context-port";

/** Display names for workspace roles. Client-safe: no server imports. */
export const ROLE_LABELS: Record<
  SessionContext["role"],
  { zh: string; en: string }
> = {
  viewer: { zh: "檢視者", en: "Viewer" },
  operator: { zh: "操作員", en: "Operator" },
  reviewer: { zh: "審核員", en: "Reviewer" },
  admin: { zh: "管理員", en: "Admin" },
  owner: { zh: "擁有者", en: "Owner" },
};

/** A role's name in the reader's language; unknown roles pass through. */
export function roleLabel(role: string, locale: Locale): string {
  const label = ROLE_LABELS[role as SessionContext["role"]];
  if (!label) return role;
  return locale === "en" ? label.en : label.zh;
}
